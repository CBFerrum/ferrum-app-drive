//! Zip downloads: a folder, or several files and folders, as one archive (`GET /archive?items=a,b`).
//! Everything below a folder the caller may view is in it (as with a copy, access comes down from
//! the folder), except what is in the trash. The archive is built here and sent whole, so it has a
//! cap on size and on the number of files; past either, nothing is built and the message says so.
//! Live documents go in as web pages, with their pictures inside. Names inside the archive are
//! made safe: no separators, no `.` or `..`, no drive letters, one name per place (a second
//! `Report.pdf` becomes `Report (2).pdf`), and every path is relative.

use crate::acl::{Grants, Level};
use crate::content;
use crate::files;
use crate::ops::Params;
use crate::tree::{self, FILE_COLS, FOLDER_COLS, Item, Kind};
use ferrum_kernel::{Ctx, Error, Kernel, Result, SiteResponse};
use sqlx::QueryBuilder;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use uuid::Uuid;

/// The most items a request may name.
const MAX_NAMED: usize = 200;
/// The most files one archive holds.
const MAX_FILES: usize = 5000;

/// The most one archive carries, before it is compressed: `FERRUM_DRIVE_MAX_ZIP_MB`, 128 MB unless
/// set, at most 1 GiB (the archive is built in memory).
pub fn max_bytes() -> i64 {
    limit(std::env::var("FERRUM_DRIVE_MAX_ZIP_MB").ok().as_deref())
}

fn limit(mb: Option<&str>) -> i64 {
    (mb.and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(128).clamp(1, 1024)) << 20
}

/// One place in the archive's tree.
#[derive(Debug, Clone)]
pub struct Node {
    pub id: Uuid,
    /// The folder it sits in within the archive; none for what was asked for.
    pub parent: Option<Uuid>,
    pub name: String,
    pub dir: bool,
}

/// An item and the path it gets in the archive (a folder's has no trailing slash).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placed {
    pub id: Uuid,
    pub path: String,
    pub dir: bool,
}

/// A name as one segment of a path: no separators, drive colons or control characters, and never
/// empty, `.` or `..`.
pub fn segment(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':') { '_' } else { c }).collect();
    let s = s.trim().to_string();
    if s.is_empty() || s == "." || s == ".." { "_".to_string() } else { s }
}

/// The paths of `nodes` in the archive, parents before what is in them, each name unique among its
/// siblings (ignoring case) and the siblings in name order. `nodes` whose parent is not among them
/// are left out.
pub fn layout(nodes: &[Node]) -> Vec<Placed> {
    let known: HashSet<Uuid> = nodes.iter().map(|n| n.id).collect();
    let mut kids: HashMap<Option<Uuid>, Vec<&Node>> = HashMap::new();
    for n in nodes {
        let parent = n.parent.filter(|p| known.contains(p));
        // Something below a folder that was not asked for or found has nowhere to be.
        if n.parent.is_some() && parent.is_none() {
            continue;
        }
        kids.entry(parent).or_default().push(n);
    }
    let mut out = Vec::new();
    let mut stack: Vec<(Option<Uuid>, String)> = vec![(None, String::new())];
    // Depth first, in order: the stack holds what is still to be opened, the last first.
    let mut pending: Vec<(Option<Uuid>, String)> = Vec::new();
    while let Some((at, prefix)) = stack.pop() {
        let mut siblings = kids.remove(&at).unwrap_or_default();
        siblings.sort_by_key(|n| (!n.dir, n.name.to_lowercase(), n.id));
        let mut taken: HashSet<String> = HashSet::new();
        pending.clear();
        for n in siblings {
            let base = segment(&n.name);
            let mut chosen = base.clone();
            let mut count = 1u32;
            while !taken.insert(chosen.to_lowercase()) {
                count += 1;
                chosen = content::numbered(&base, count, n.dir);
            }
            let path = if prefix.is_empty() { chosen } else { format!("{prefix}/{chosen}") };
            out.push(Placed { id: n.id, path: path.clone(), dir: n.dir });
            if n.dir {
                pending.push((Some(n.id), path));
            }
        }
        // Folders are opened in name order: the first goes on the stack last.
        stack.extend(pending.drain(..).rev());
    }
    out
}

/// Whether an archive of this size may be built, or why not.
pub fn check_caps(files: usize, bytes: i64, max_bytes: i64) -> Result<()> {
    if files > MAX_FILES {
        return Err(Error::invalid(format!("a zip file holds at most {MAX_FILES} files; this has {files}. Download smaller parts")));
    }
    if bytes > max_bytes {
        return Err(Error::invalid(format!("a zip file holds at most {} MB; this is {} MB. Download smaller parts", max_bytes >> 20, (bytes >> 20).max(1))));
    }
    Ok(())
}

/// A name for the archive: the item's, or a general one for several.
pub fn archive_name(tops: &[Item]) -> String {
    match tops {
        [one] => format!("{}.zip", segment(&one.name)),
        _ => "Drive files.zip".to_string(),
    }
}

/// Already compressed: stored as it is, not compressed again.
fn stored(file_type: Option<&str>) -> bool {
    matches!(file_type, Some("Image" | "Video" | "Audio" | "Archive" | "PDF"))
}

/// `GET /archive?items=id,id`: the archive of what the caller names, with the rights they have.
pub async fn build(k: &Kernel, ctx: &Ctx, p: &Params<'_>) -> Result<SiteResponse> {
    let ids: Vec<Uuid> = p.req("items")?.split(',').filter(|s| !s.is_empty()).map(|s| s.parse().map_err(|_| tree::missing())).collect::<Result<_>>()?;
    if ids.is_empty() || ids.len() > MAX_NAMED {
        return Err(Error::field("items", format!("name between 1 and {MAX_NAMED} items")));
    }
    let cap = max_bytes();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let g = Grants::load(&mut tx, ctx).await?;
    let mut tops = Vec::new();
    for id in &ids {
        // A repeated id is one item.
        if !tops.iter().any(|t: &Item| t.id == *id) {
            tops.push(tree::open(&mut tx, ctx, &g, *id, Level::View, false).await?);
        }
    }
    let mut nodes: Vec<Node> = tops.iter().map(|t| Node { id: t.id, parent: None, name: t.name.clone(), dir: t.kind == Kind::Folder }).collect();
    let mut files_in: HashMap<Uuid, Item> = tops.iter().filter(|t| t.kind == Kind::File).map(|t| (t.id, t.clone())).collect();
    for top in tops.iter().filter(|t| t.kind == Kind::Folder) {
        let key = top.id.to_string();
        let mut qb = QueryBuilder::new(format!("select {FOLDER_COLS} from e_drive_folder a where a.tenant_id = "));
        qb.push_bind(ctx.tenant).push(" and a.ancestors ? ").push_bind(key.clone());
        let folders = tree::fetch(&mut tx, &mut qb).await?;
        let mut qb = QueryBuilder::new(format!("select {FILE_COLS} from e_drive_file a where a.tenant_id = "));
        qb.push_bind(ctx.tenant).push(" and a.ancestors ? ").push_bind(key).push(" and not a.trashed");
        let below = tree::fetch(&mut tx, &mut qb).await?;
        // Nothing in the trash goes in: trashed folders and everything below them stay behind.
        let gone: HashSet<Uuid> = folders.iter().filter(|f| f.trashed).map(|f| f.id).collect();
        let keep = |i: &Item| !i.trashed && !i.ancestors.iter().any(|a| gone.contains(a));
        for f in folders.into_iter().filter(keep) {
            nodes.push(Node { id: f.id, parent: f.parent, name: f.name, dir: true });
        }
        for f in below.into_iter().filter(keep) {
            nodes.push(Node { id: f.id, parent: f.parent, name: f.name.clone(), dir: false });
            files_in.insert(f.id, f);
        }
    }
    // What the person asked for sits at the top, whatever folder it was in.
    let placed = layout(&nodes);
    let bytes: i64 = files_in.values().map(|f| f.size).sum();
    check_caps(files_in.len(), bytes, cap)?;

    // Everything the database holds is read now; the bytes are read once the transaction is done.
    let mut live = HashMap::new();
    let mut stored_at = HashMap::new();
    for f in files_in.values() {
        if crate::docs::is_live(f) {
            live.insert(f.id, crate::docs::current(k, ctx, &mut tx, f).await?);
        } else {
            let (object, ..) = files::version(&mut tx, ctx.tenant, f, None).await?;
            stored_at.insert(f.id, object);
        }
    }
    for top in &tops {
        tree::log(&mut tx, ctx, top, "Download", serde_json::json!({"zip": true, "files": files_in.len(), "bytes": bytes})).await?;
    }
    tx.commit().await?;

    let mut not_carried: Vec<String> = Vec::new();
    let fail = |e: &dyn std::fmt::Display| Error::internal(format!("building a zip file: {e}"));
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for entry in &placed {
        let item = files_in.get(&entry.id);
        let when = item.and_then(|i| {
            use chrono::{Datelike, Timelike};
            let t = i.modified_at;
            zip::DateTime::from_date_and_time(t.year() as u16, t.month() as u8, t.day() as u8, t.hour() as u8, t.minute() as u8, t.second() as u8).ok()
        });
        let method = if stored(item.and_then(|i| i.file_type.as_deref())) { zip::CompressionMethod::Stored } else { zip::CompressionMethod::Deflated };
        let mut opts = zip::write::SimpleFileOptions::default().compression_method(method);
        if let Some(when) = when {
            opts = opts.last_modified_time(when);
        }
        if entry.dir {
            zip.add_directory(format!("{}/", entry.path), opts).map_err(|e| fail(&e))?;
            continue;
        }
        let Some(item) = item else { continue };
        let (path, data) = if let Some(state) = live.get(&item.id) {
            let images = crate::images::for_export(k, ctx, Some(&g), item.id, state).await?;
            let (page, lost) = crate::site::live_page(k, &item.name, state, &images);
            not_carried.extend(lost);
            // A live document goes in as a page: its name says so.
            let path = match entry.path.strip_suffix(".fdoc") {
                Some(stem) => format!("{stem}.html"),
                None => entry.path.clone(),
            };
            (path, page)
        } else {
            let Some(object) = stored_at.get(&item.id) else { continue };
            (entry.path.clone(), files::read(k, ctx, *object).await?)
        };
        zip.start_file(path, opts).map_err(|e| fail(&e))?;
        zip.write_all(&data).map_err(|e| fail(&e))?;
    }
    let body = zip.finish().map_err(|e| fail(&e))?.into_inner();
    let mut headers = vec![
        ("content-disposition".to_string(), content::disposition(false, &archive_name(&tops))),
        ("x-content-type-options".into(), "nosniff".into()),
        ("cache-control".into(), "private, no-store".into()),
    ];
    // What the live documents in it could not carry as web pages, once each.
    not_carried.sort();
    not_carried.dedup();
    headers.extend(crate::site::not_carried_header(&not_carried));
    Ok(SiteResponse { status: 200, content_type: "application/zip".into(), headers, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(n: u128, parent: Option<u128>, name: &str, dir: bool) -> Node {
        Node { id: Uuid::from_u128(n), parent: parent.map(Uuid::from_u128), name: name.into(), dir }
    }
    fn paths(nodes: &[Node]) -> Vec<String> {
        layout(nodes).into_iter().map(|p| if p.dir { format!("{}/", p.path) } else { p.path }).collect()
    }

    #[test]
    fn a_folder_and_what_is_in_it_get_relative_paths_in_order() {
        let nodes = [
            node(1, None, "Reports", true),
            node(2, Some(1), "b.txt", false),
            node(3, Some(1), "Q3", true),
            node(4, Some(3), "plan.pdf", false),
            node(5, Some(1), "a.txt", false),
            node(6, None, "notes.md", false),
        ];
        assert_eq!(paths(&nodes), ["Reports/", "notes.md", "Reports/Q3/", "Reports/a.txt", "Reports/b.txt", "Reports/Q3/plan.pdf"]);
    }

    #[test]
    fn a_taken_name_is_numbered_whatever_its_case() {
        let nodes = [
            node(1, None, "Report.pdf", false),
            node(2, None, "report.PDF", false),
            node(3, None, "Report.pdf", false),
            node(4, None, "Data", true),
            node(5, None, "data", true),
        ];
        let got = paths(&nodes);
        assert_eq!(got.len(), 5);
        let lower: HashSet<String> = got.iter().map(|p| p.to_lowercase()).collect();
        assert_eq!(lower.len(), 5, "{got:?}");
        assert!(got.contains(&"Report (2).pdf".to_string()) || got.iter().any(|p| p.starts_with("report (2)")), "{got:?}");
        assert!(got.iter().any(|p| p == "Data (2)/" || p == "data (2)/"), "{got:?}");
    }

    #[test]
    fn names_cannot_climb_out_or_point_at_a_drive() {
        assert_eq!(segment("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(segment("C:\\Windows\\x.dll"), "C__Windows_x.dll");
        assert_eq!([segment(".."), segment("."), segment("  "), segment("")], ["_", "_", "_", "_"]);
        assert_eq!(segment("a\0b\nc"), "a_b_c");
        let nodes = [node(1, None, "..", true), node(2, Some(1), "/etc/passwd", false), node(3, Some(1), "..", false)];
        for p in layout(&nodes) {
            assert!(!p.path.starts_with('/') && !p.path.split('/').any(|s| s == ".." || s == "." || s.is_empty()), "{p:?}");
        }
    }

    #[test]
    fn what_is_below_a_folder_that_is_not_there_is_left_out() {
        let nodes = [node(1, None, "a.txt", false), node(2, Some(99), "lost.txt", false)];
        assert_eq!(paths(&nodes), ["a.txt"]);
    }

    #[test]
    fn the_cap_names_what_is_too_much() {
        assert!(check_caps(10, 1 << 20, 128 << 20).is_ok());
        assert!(format!("{}", check_caps(5001, 0, 128 << 20).unwrap_err()).contains("5000 files"));
        assert!(format!("{}", check_caps(1, 200 << 20, 128 << 20).unwrap_err()).contains("128 MB"));
        assert_eq!(
            (limit(None), limit(Some("512")), limit(Some("0")), limit(Some("9999")), limit(Some("x"))),
            (128 << 20, 512 << 20, 1 << 20, 1 << 30, 128 << 20)
        );
    }

    #[test]
    fn the_archive_is_named_for_one_item_or_generally() {
        let one = |name: &str| Item {
            kind: Kind::Folder,
            id: Uuid::nil(),
            name: name.into(),
            parent: None,
            root: None,
            ancestors: vec![],
            owner: None,
            is_team: false,
            trashed: false,
            trashed_at: None,
            colour: None,
            size: 0,
            content_type: None,
            file_type: None,
            version_no: 0,
            sha256: None,
            locked_by: None,
            locked_at: None,
            modified_at: chrono::Utc::now(),
            modified_by: None,
            created_at: chrono::Utc::now(),
        };
        assert_eq!(archive_name(&[one("Q3 reports")]), "Q3 reports.zip");
        assert_eq!(archive_name(&[one("a"), one("b")]), "Drive files.zip");
        assert_eq!(archive_name(&[one("../x")]), ".._x.zip");
        assert!(stored(Some("Image")) && !stored(Some("Text")) && !stored(None));
    }

    #[test]
    fn an_archive_written_with_these_paths_reads_back() {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.add_directory("Reports/", opts).unwrap();
        zip.start_file("Reports/a.txt", opts).unwrap();
        zip.write_all(b"hello").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut s = String::new();
        std::io::Read::read_to_string(&mut z.by_name("Reports/a.txt").unwrap(), &mut s).unwrap();
        assert_eq!(s, "hello");
    }
}

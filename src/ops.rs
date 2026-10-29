//! Drive's operations. Each is an action on the caller's own Drive Space (the generic API and MCP
//! reach Drive through those actions), and the read-only ones are also served at
//! `GET /api/app/drive/{action}`. Every operation runs in the caller's transaction, loads the
//! caller's grants once and checks each item it touches with [`tree::open`] — the only door to
//! an item.

use crate::acl::{Grants, Level};
use crate::files;
use crate::sharing;
use crate::tree::{self, FILE_COLS, FOLDER_COLS, Item, Kind, Space};
use crate::{content, day_start, now};
use base64::Engine as _;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use chrono::{DateTime, NaiveDate, Utc};
use ferrum_domain::util::elevated;
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, Tx, notify};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub type Out = Result<Value>;

/// Folders nest at most this deep.
const MAX_DEPTH: usize = 64;
/// One copy handles at most this many items and bytes.
const COPY_ITEMS: usize = 1000;
const COPY_BYTES: i64 = 1 << 30;

/// Read-only actions (also served at `GET /api/app/drive/{action}`).
pub const READS: &[&str] = &[
    "list_folder",
    "search",
    "recent",
    "starred",
    "shared_with_me",
    "list_trash",
    "usage",
    "item_info",
    "list_versions",
    "download",
    "list_shares",
    "list_links",
    "activity",
    "list_comments",
];

const B64: GeneralPurpose =
    GeneralPurpose::new(&base64::alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent));
const B64_URL: GeneralPurpose =
    GeneralPurpose::new(&base64::alphabet::URL_SAFE, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent));

/// Action parameters (a JSON object; query-string values arrive as strings and are accepted).
pub struct Params<'a>(pub &'a Value);

impl<'a> Params<'a> {
    pub fn str(&self, k: &str) -> Option<&'a str> {
        self.0.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
    }
    pub fn req(&self, k: &str) -> Result<&'a str> {
        self.str(k).ok_or_else(|| Error::field(k, "is required"))
    }
    pub fn uuid(&self, k: &str) -> Result<Option<Uuid>> {
        match self.str(k) {
            None => Ok(None),
            Some(s) => s.parse().map(Some).map_err(|_| Error::field(k, "is not a valid id")),
        }
    }
    pub fn req_uuid(&self, k: &str) -> Result<Uuid> {
        self.uuid(k)?.ok_or_else(|| Error::field(k, "is required"))
    }
    pub fn int(&self, k: &str) -> Result<Option<i64>> {
        match self.0.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Number(n)) => n.as_i64().map(Some).ok_or_else(|| Error::field(k, "must be a whole number")),
            Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
            Some(Value::String(s)) => s.trim().parse().map(Some).map_err(|_| Error::field(k, "must be a whole number")),
            _ => Err(Error::field(k, "must be a whole number")),
        }
    }
    pub fn flag(&self, k: &str) -> bool {
        match self.0.get(k) {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => matches!(s.trim(), "true" | "1" | "yes"),
            Some(Value::Number(n)) => n.as_i64() == Some(1),
            _ => false,
        }
    }
    pub fn date(&self, k: &str) -> Result<Option<NaiveDate>> {
        match self.str(k) {
            None => Ok(None),
            Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d").map(Some).map_err(|_| Error::field(k, "use the format YYYY-MM-DD")),
        }
    }
    /// File content from `content_base64` (standard or URL-safe, padding optional) or `text`.
    pub fn content(&self) -> Result<Option<Vec<u8>>> {
        if let Some(b) = self.0.get("content_base64").and_then(Value::as_str) {
            let b: String = b.chars().filter(|c| !c.is_whitespace()).collect();
            return B64.decode(&b).or_else(|_| B64_URL.decode(&b)).map(Some).map_err(|_| Error::field("content_base64", "is not valid base64"));
        }
        Ok(self.0.get("text").and_then(Value::as_str).map(|t| t.as_bytes().to_vec()))
    }
    fn page(&self, default: i64, max: i64) -> Result<(i64, i64)> {
        let limit = self.int("limit")?.unwrap_or(default).clamp(1, max);
        let offset = self.int("offset")?.unwrap_or(0);
        if !(0..=100_000).contains(&offset) {
            return Err(Error::field("offset", "must be between 0 and 100000"));
        }
        Ok((limit, offset))
    }
}

/// Runs a Drive operation for the caller (`space` is their own space: the default folder).
pub async fn run(k: &Kernel, ctx: &Ctx, tx: &mut Tx, space: &Space, name: &str, params: &Value) -> Out {
    if !(params.is_object() || params.is_null()) {
        return Err(Error::invalid("action parameters must be a JSON object"));
    }
    let empty = json!({});
    let p = Params(if params.is_null() { &empty } else { params });
    let g = Grants::load(tx, ctx).await?;
    let g = &g;
    match name {
        "list_folder" => list_folder(tx, ctx, g, space, &p).await,
        "search" => search(tx, ctx, g, &p).await,
        "recent" => recent(tx, ctx, g, &p).await,
        "starred" => starred(tx, ctx, g).await,
        "shared_with_me" => shared_with_me(tx, ctx, g).await,
        "list_trash" => list_trash(tx, ctx, g, &p).await,
        "usage" => usage(tx, ctx, g, space).await,
        "item_info" => item_info(tx, ctx, g, &p).await,
        "list_versions" => files::list_versions(tx, ctx, g, &p).await,
        "download" => files::download(k, ctx, tx, g, &p).await,
        "list_shares" => sharing::list_shares(tx, ctx, g, &p).await,
        "list_links" => sharing::list_links(tx, ctx, g, &p).await,
        "activity" => activity(tx, ctx, g, &p).await,
        "list_comments" => list_comments(tx, ctx, g, &p).await,
        "upload" => files::upload_action(k, ctx, tx, g, space, &p).await,
        "upload_version" => files::upload_version_action(k, ctx, tx, g, &p).await,
        "create_folder" => create_folder(k, ctx, tx, g, space, &p).await,
        "create_team_folder" => create_team_folder(k, ctx, tx, g, &p).await,
        "add_team_member" => team_member(k, ctx, tx, g, &p, true).await,
        "remove_team_member" => team_member(k, ctx, tx, g, &p, false).await,
        "set_team_quota" => set_team_quota(k, ctx, tx, g, &p).await,
        "rename" => rename(k, ctx, tx, g, &p).await,
        "set_colour" => set_colour(k, ctx, tx, g, &p).await,
        "move" => move_item(k, ctx, tx, g, &p).await,
        "copy" => copy(k, ctx, tx, g, &p).await,
        "trash" => trash(k, ctx, tx, g, &p).await,
        "restore" => restore(k, ctx, tx, g, &p).await,
        "delete_forever" => delete_forever(ctx, tx, g, &p).await,
        "empty_trash" => empty_trash(ctx, tx, g, &p).await,
        "check_out" => files::check_out(k, ctx, tx, g, &p).await,
        "check_in" => files::check_in(k, ctx, tx, g, &p).await,
        "restore_version" => files::restore_version(k, ctx, tx, g, &p).await,
        "share" => sharing::share(k, ctx, tx, g, &p).await,
        "unshare" => sharing::unshare(k, ctx, tx, g, &p).await,
        "create_link" => sharing::create_link(k, ctx, tx, g, &p).await,
        "revoke_link" => sharing::revoke_link(ctx, tx, g, &p).await,
        "star" => star(ctx, tx, g, &p, true).await,
        "unstar" => star(ctx, tx, g, &p, false).await,
        "add_comment" => add_comment(k, ctx, tx, g, &p).await,
        "delete_comment" => delete_comment(k, ctx, tx, g, &p).await,
        _ => Err(Error::NotFound(format!("action {name}"))),
    }
}

fn clean(name: &str) -> Result<String> {
    content::clean_name(name).map_err(|m| Error::field("name", m))
}

fn colour(p: &Params<'_>) -> Result<Option<String>> {
    match p.str("colour") {
        None => Ok(None),
        Some(c) => {
            let hex = c.strip_prefix('#').unwrap_or("");
            if (hex.len() == 3 || hex.len() == 6) && hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
                Ok(Some(c.to_lowercase()))
            } else {
                Err(Error::field("colour", "use a hex colour such as #3b82f6"))
            }
        }
    }
}

/// `order by` for `keys` in one direction (keys are fixed strings, never user input).
fn order(keys: &[&str], desc: bool) -> String {
    keys.iter().map(|k| format!("{k} {}", if desc { "desc" } else { "asc" })).collect::<Vec<_>>().join(", ")
}

async fn reload(tx: &mut Tx, tenant: Uuid, kind: Kind, id: Uuid) -> Result<Item> {
    tree::load_kind(tx, tenant, kind, id, false).await?.ok_or_else(tree::missing)
}

/// Paths of items as the caller may see them (`Team / Plans / Q3`), from the first visible folder.
async fn paths(tx: &mut Tx, tenant: Uuid, g: &Grants, items: &[Item]) -> Result<Vec<String>> {
    let all: Vec<Uuid> = items.iter().flat_map(|i| i.ancestors.iter().copied()).collect::<HashSet<_>>().into_iter().collect();
    let names: HashMap<Uuid, String> = sqlx::query_as::<_, (Uuid, String)>("select id, name from e_drive_folder where tenant_id = $1 and id = any($2)")
        .bind(tenant)
        .bind(&all)
        .fetch_all(&mut **tx)
        .await?
        .into_iter()
        .collect();
    Ok(items
        .iter()
        .map(|i| {
            let a = &i.ancestors;
            let top = a.first().copied();
            let first = (0..a.len()).find(|&n| g.level(a[n], if n == 0 { None } else { top }, &a[..n]) >= Level::View).unwrap_or(a.len());
            a[first..].iter().filter_map(|id| names.get(id).cloned()).collect::<Vec<_>>().join(" / ")
        })
        .collect())
}

// ───────────────────────────── views ─────────────────────────────

/// `list_folder`: sub-folders first, then files; with the visible breadcrumbs.
async fn list_folder(tx: &mut Tx, ctx: &Ctx, g: &Grants, space: &Space, p: &Params<'_>) -> Out {
    let folder = tree::open_kind(tx, ctx, g, Kind::Folder, p.uuid("folder")?.unwrap_or(space.root), Level::View, false).await?;
    let (limit, offset) = p.page(50, 200)?;
    let desc = match p.str("order") {
        None | Some("asc") => false,
        Some("desc") => true,
        Some(_) => return Err(Error::field("order", "must be asc or desc")),
    };
    let (folder_keys, file_keys): (&[&str], &[&str]) = match p.str("sort").unwrap_or("name") {
        "name" => (&["lower(a.name)", "a.id"], &["lower(a.name)", "a.id"]),
        "modified" => (&["a.updated_at", "a.id"], &["coalesce(a.modified_at, a.created_at)", "a.id"]),
        "size" => (&["lower(a.name)", "a.id"], &["a.size", "a.id"]),
        "type" => (&["lower(a.name)", "a.id"], &["a.file_type", "lower(a.name)", "a.id"]),
        _ => return Err(Error::field("sort", "must be name, modified, size or type")),
    };
    let (folders, files): (i64, i64) = sqlx::query_as(
        "select (select count(*) from e_drive_folder where tenant_id = $1 and parent = $2 and not trashed), \
                (select count(*) from e_drive_file where tenant_id = $1 and folder = $2 and not trashed)",
    )
    .bind(ctx.tenant)
    .bind(folder.id)
    .fetch_one(&mut **tx)
    .await?;
    let mut items = Vec::new();
    if offset < folders {
        let mut qb = QueryBuilder::new(format!("select {FOLDER_COLS} from e_drive_folder a where a.tenant_id = "));
        qb.push_bind(ctx.tenant).push(" and a.parent = ").push_bind(folder.id).push(" and not a.trashed order by ");
        qb.push(order(folder_keys, desc)).push(" limit ").push_bind(limit).push(" offset ").push_bind(offset);
        items.extend(tree::fetch(tx, &mut qb).await?);
    }
    let rest = limit - items.len() as i64;
    if rest > 0 {
        let mut qb = QueryBuilder::new(format!("select {FILE_COLS} from e_drive_file a where a.tenant_id = "));
        qb.push_bind(ctx.tenant).push(" and a.folder = ").push_bind(folder.id).push(" and not a.trashed order by ");
        qb.push(order(file_keys, desc)).push(" limit ").push_bind(rest).push(" offset ").push_bind((offset - folders).max(0));
        items.extend(tree::fetch(tx, &mut qb).await?);
    }
    let star = tree::starred(tx, ctx.tenant, &g.email, &[folder.id]).await?;
    Ok(json!({
        "folder": folder.json(folder.level(g), star.contains(&folder.id)),
        "breadcrumbs": tree::breadcrumbs(tx, ctx.tenant, g, &folder).await?,
        "items": tree::items_json(tx, ctx.tenant, g, &items).await?,
        "total": folders + files, "folders": folders, "files": files, "limit": limit, "offset": offset,
    }))
}

/// One branch of a search: `(select <cols> from <table> a where <tenant, access and filters>)`.
struct SearchFilter<'a> {
    query: Option<&'a str>,
    file_type: Option<&'a str>,
    owner: Option<String>,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
    within: Option<Uuid>,
}

fn search_branch(qb: &mut QueryBuilder<Postgres>, ctx: &Ctx, g: &Grants, kind: Kind, f: &SearchFilter<'_>) {
    let (cols, modified) = match kind {
        Kind::Folder => (FOLDER_COLS, "a.updated_at"),
        Kind::File => (FILE_COLS, "coalesce(a.modified_at, a.created_at)"),
    };
    qb.push(format!("(select {cols} from {} a where a.tenant_id = ", kind.table())).push_bind(ctx.tenant).push(" and not a.trashed");
    if kind == Kind::Folder {
        // A space's top folder is where you are, not something you find.
        qb.push(" and not (a.parent is null and not a.is_team)");
    }
    g.push_visible(qb, "a");
    if let Some(q) = f.query {
        let pattern = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        qb.push(" and a.name ilike ").push_bind(pattern);
    }
    if let (Kind::File, Some(t)) = (kind, f.file_type) {
        qb.push(" and a.file_type = ").push_bind(t.to_string());
    }
    if let Some(o) = &f.owner {
        qb.push(" and a.owner = ").push_bind(o.clone());
    }
    if let Some(t) = f.from {
        qb.push(format!(" and {modified} >= ")).push_bind(t);
    }
    if let Some(t) = f.to {
        qb.push(format!(" and {modified} < ")).push_bind(t);
    }
    if let Some(w) = f.within {
        qb.push(" and a.ancestors ? ").push_bind(w.to_string());
    }
    qb.push(")");
}

/// `search`: by name (substring, any case) and/or type, owner, modification dates (workspace
/// time zone) and folder, across everything the caller can see and nothing in the trash.
async fn search(tx: &mut Tx, ctx: &Ctx, g: &Grants, p: &Params<'_>) -> Out {
    let query = p.str("query");
    if query.is_some_and(|q| q.chars().count() > 100) {
        return Err(Error::field("query", "at most 100 characters"));
    }
    let file_type = p.str("type");
    const TYPES: &[&str] = &["folder", "Document", "Spreadsheet", "Presentation", "PDF", "Image", "Video", "Audio", "Archive", "Text", "Other"];
    if file_type.is_some_and(|t| !TYPES.contains(&t)) {
        return Err(Error::field("type", format!("must be one of: {}", TYPES.join(", "))));
    }
    let tz = ctx.schema.timezone.clone();
    let within = match p.uuid("folder")? {
        Some(id) => Some(tree::open_kind(tx, ctx, g, Kind::Folder, id, Level::View, false).await?.id),
        None => None,
    };
    let f = SearchFilter {
        query,
        file_type: file_type.filter(|t| *t != "folder"),
        owner: p.str("owner").map(str::to_lowercase),
        from: p.date("modified_from")?.map(|d| day_start(&tz, d)),
        to: p.date("modified_to")?.and_then(|d| d.succ_opt()).map(|d| day_start(&tz, d)),
        within,
    };
    if f.query.is_none() && file_type.is_none() && f.owner.is_none() && f.from.is_none() && f.to.is_none() && f.within.is_none() {
        return Err(Error::field("query", "give a name to search for, or a type, owner, date or folder filter"));
    }
    let (limit, offset) = p.page(50, 200)?;
    let sort = match p.str("sort").unwrap_or("modified") {
        "modified" => "x.modified_at desc, x.id",
        "name" => "lower(x.name), x.id",
        "size" => "x.size desc, x.id",
        _ => return Err(Error::field("sort", "must be modified, name or size")),
    };
    let mut qb = QueryBuilder::new("select x.* from (");
    let folders = file_type.is_none() || file_type == Some("folder");
    let files = file_type != Some("folder");
    if folders {
        search_branch(&mut qb, ctx, g, Kind::Folder, &f);
    }
    if files {
        if folders {
            qb.push(" union all ");
        }
        search_branch(&mut qb, ctx, g, Kind::File, &f);
    }
    qb.push(") x where not exists (select 1 from e_drive_folder t where t.tenant_id = ").push_bind(ctx.tenant);
    qb.push(" and t.trashed and x.ancestors ? t.id::text) order by ").push(sort).push(" limit ").push_bind(limit + 1).push(" offset ").push_bind(offset);
    let mut items = tree::fetch(tx, &mut qb).await?;
    let more = items.len() as i64 > limit;
    items.truncate(limit as usize);
    let paths = paths(tx, ctx.tenant, g, &items).await?;
    let mut out = tree::items_json(tx, ctx.tenant, g, &items).await?;
    for (v, path) in out.iter_mut().zip(paths) {
        v["path"] = json!(path);
    }
    Ok(json!({"items": out, "has_more": more, "limit": limit, "offset": offset}))
}

/// Keeps the visible, live items of `ids` in that order.
async fn visible_in_order(tx: &mut Tx, tenant: Uuid, g: &Grants, ids: &[Uuid]) -> Result<Vec<Item>> {
    let mut found = tree::load_many(tx, tenant, Kind::Folder, ids).await?;
    found.extend(tree::load_many(tx, tenant, Kind::File, ids).await?);
    let found = tree::keep_live(tx, tenant, found).await?;
    let by_id: HashMap<Uuid, Item> = found.into_iter().filter(|i| i.level(g) >= Level::View).map(|i| (i.id, i)).collect();
    Ok(ids.iter().filter_map(|id| by_id.get(id).cloned()).collect())
}

/// `recent`: files the caller worked with lately (uploads, downloads, edits), newest first.
async fn recent(tx: &mut Tx, ctx: &Ctx, g: &Grants, p: &Params<'_>) -> Out {
    let limit = p.int("limit")?.unwrap_or(20).clamp(1, 100) as usize;
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "select file from e_drive_activity where tenant_id = $1 and actor = $2 and file is not null and created_at > now() - interval '90 days' \
         group by file order by max(created_at) desc limit 500",
    )
    .bind(ctx.tenant)
    .bind(&g.email)
    .fetch_all(&mut **tx)
    .await?;
    let mut items = visible_in_order(tx, ctx.tenant, g, &ids).await?;
    items.truncate(limit);
    Ok(json!({"items": tree::items_json(tx, ctx.tenant, g, &items).await?}))
}

/// `starred`: the caller's starred items they can still see, newest star first.
async fn starred(tx: &mut Tx, ctx: &Ctx, g: &Grants) -> Out {
    let ids: Vec<Uuid> =
        sqlx::query_scalar("select coalesce(file, folder) from e_drive_star where tenant_id = $1 and email = $2 order by created_at desc limit 1000")
            .bind(ctx.tenant)
            .bind(&g.email)
            .fetch_all(&mut **tx)
            .await?;
    let items = visible_in_order(tx, ctx.tenant, g, &ids).await?;
    Ok(json!({"items": tree::items_json(tx, ctx.tenant, g, &items).await?}))
}

/// `shared_with_me`: items shared with the caller or their roles (not their own), newest first.
async fn shared_with_me(tx: &mut Tx, ctx: &Ctx, g: &Grants) -> Out {
    let rows: Vec<(Uuid, Option<String>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "select coalesce(file, folder), shared_by, expires_at from e_drive_share where tenant_id = $1 and (email = $2 or role = any($3)) \
         and (expires_at is null or expires_at > now()) order by created_at desc limit 1000",
    )
    .bind(ctx.tenant)
    .bind(&g.email)
    .bind(&ctx.roles)
    .fetch_all(&mut **tx)
    .await?;
    let mut seen = HashSet::new();
    let ids: Vec<Uuid> = rows.iter().map(|r| r.0).filter(|id| seen.insert(*id)).collect();
    let items: Vec<Item> = visible_in_order(tx, ctx.tenant, g, &ids).await?.into_iter().filter(|i| i.owner.as_deref() != Some(g.email.as_str())).collect();
    let mut out = tree::items_json(tx, ctx.tenant, g, &items).await?;
    for (v, item) in out.iter_mut().zip(&items) {
        if let Some(r) = rows.iter().find(|r| r.0 == item.id) {
            v["shared_by"] = json!(r.1);
            v["share_expires_at"] = json!(r.2);
        }
    }
    Ok(json!({"items": out}))
}

/// Items in the trash themselves (not inside a trashed folder) that the caller may act on at
/// `needed`, optionally in one tree; newest first, at most 500.
async fn trash_items(tx: &mut Tx, ctx: &Ctx, g: &Grants, root: Option<Uuid>, needed: Level) -> Result<Vec<Item>> {
    let mut out = Vec::new();
    for kind in [Kind::Folder, Kind::File] {
        let cols = if kind == Kind::Folder { FOLDER_COLS } else { FILE_COLS };
        let mut qb = QueryBuilder::new(format!("select {cols} from {} a where a.tenant_id = ", kind.table()));
        qb.push_bind(ctx.tenant).push(" and a.trashed");
        if let Some(r) = root {
            qb.push(" and (a.root = ").push_bind(r).push(" or a.id = ").push_bind(r).push(")");
        }
        g.push_visible(&mut qb, "a");
        qb.push(" and not exists (select 1 from e_drive_folder t where t.tenant_id = a.tenant_id and t.trashed and a.ancestors ? t.id::text)");
        qb.push(" order by a.trashed_at desc limit 500");
        out.extend(tree::fetch(tx, &mut qb).await?.into_iter().filter(|i| i.level(g) >= needed));
    }
    out.sort_by_key(|i| std::cmp::Reverse(i.trashed_at));
    out.truncate(500);
    Ok(out)
}

/// `list_trash`: what the caller can restore, newest first.
async fn list_trash(tx: &mut Tx, ctx: &Ctx, g: &Grants, p: &Params<'_>) -> Out {
    let (limit, offset) = p.page(50, 200)?;
    let items = trash_items(tx, ctx, g, p.uuid("root")?, Level::Edit).await?;
    let total = items.len();
    let page: Vec<Item> = items.into_iter().skip(offset as usize).take(limit as usize).collect();
    Ok(json!({"items": tree::items_json(tx, ctx.tenant, g, &page).await?, "total": total}))
}

/// `usage`: the caller's quota and use, and those of their team folders.
async fn usage(tx: &mut Tx, ctx: &Ctx, g: &Grants, space: &Space) -> Out {
    let (quota, used): (Option<i64>, Option<i64>) = sqlx::query_as("select quota_mb, used_bytes from e_drive_space where tenant_id = $1 and id = $2")
        .bind(ctx.tenant)
        .bind(space.id)
        .fetch_one(&mut **tx)
        .await?;
    let mut qb = QueryBuilder::new("select a.id, a.name, a.quota_mb, a.used_bytes from e_drive_folder a where a.tenant_id = ");
    qb.push_bind(ctx.tenant).push(" and a.is_team and not a.trashed");
    if !g.admin {
        qb.push(" and a.id = any(").push_bind(g.roots.keys().copied().collect::<Vec<_>>()).push(")");
    }
    qb.push(" order by lower(a.name) limit 500");
    let teams: Vec<(Uuid, String, Option<i64>, Option<i64>)> = qb.build_query_as().fetch_all(&mut **tx).await?;
    let mb = |q: Option<i64>| q.filter(|q| *q > 0).map(|q| q << 20);
    Ok(json!({
        "space": {"id": space.id, "owner": space.owner, "root": space.root, "quota_bytes": mb(quota), "used_bytes": used.unwrap_or(0)},
        "teams": teams.into_iter().map(|(id, name, q, u)| json!({"id": id, "name": name, "quota_bytes": mb(q), "used_bytes": u.unwrap_or(0),
            "permission": g.level(id, None, &[]).name()})).collect::<Vec<_>>(),
    }))
}

/// `item_info`: one item with its place and counts.
async fn item_info(tx: &mut Tx, ctx: &Ctx, g: &Grants, p: &Params<'_>) -> Out {
    let item = tree::open(tx, ctx, g, p.req_uuid("item")?, Level::View, false).await?;
    let star = tree::starred(tx, ctx.tenant, &g.email, &[item.id]).await?;
    let mut out = item.json(item.level(g), star.contains(&item.id));
    out["breadcrumbs"] = json!(tree::breadcrumbs(tx, ctx.tenant, g, &item).await?);
    out["path"] = json!(paths(tx, ctx.tenant, g, std::slice::from_ref(&item)).await?.pop());
    let counts: (i64, i64) = match item.kind {
        Kind::File => {
            sqlx::query_as(
                "select (select count(*) from e_drive_file_version where tenant_id = $1 and file = $2), \
                        (select count(*) from e_drive_comment where tenant_id = $1 and file = $2)",
            )
            .bind(ctx.tenant)
            .bind(item.id)
            .fetch_one(&mut **tx)
            .await?
        }
        Kind::Folder => {
            sqlx::query_as(
                "select (select count(*) from e_drive_folder where tenant_id = $1 and parent = $2 and not trashed), \
                        (select count(*) from e_drive_file where tenant_id = $1 and folder = $2 and not trashed)",
            )
            .bind(ctx.tenant)
            .bind(item.id)
            .fetch_one(&mut **tx)
            .await?
        }
    };
    match item.kind {
        Kind::File => {
            out["versions"] = json!(counts.0);
            out["comments"] = json!(counts.1);
        }
        Kind::Folder => {
            out["folders"] = json!(counts.0);
            out["files"] = json!(counts.1);
        }
    }
    Ok(out)
}

/// `activity`: what happened to an item (for a folder: to everything in it), newest first.
async fn activity(tx: &mut Tx, ctx: &Ctx, g: &Grants, p: &Params<'_>) -> Out {
    let item = tree::open(tx, ctx, g, p.req_uuid("item")?, Level::View, false).await?;
    let limit = p.int("limit")?.unwrap_or(50).clamp(1, 200);
    type R = (Uuid, DateTime<Utc>, Option<String>, Option<String>, Option<String>, Option<Uuid>, Option<Uuid>, Option<Value>);
    let rows: Vec<R> = match item.kind {
        Kind::File => {
            sqlx::query_as(
                "select id, created_at, action, item_name, actor, file, folder, details from e_drive_activity \
             where tenant_id = $1 and file = $2 order by created_at desc, id desc limit $3",
            )
            .bind(ctx.tenant)
            .bind(item.id)
            .bind(limit)
            .fetch_all(&mut **tx)
            .await?
        }
        Kind::Folder => {
            sqlx::query_as(
                "select v.id, v.created_at, v.action, v.item_name, v.actor, v.file, v.folder, v.details from e_drive_activity v \
             where v.tenant_id = $1 and (v.folder = $2 \
               or v.file in (select id from e_drive_file where tenant_id = $1 and ancestors ? $3) \
               or v.folder in (select id from e_drive_folder where tenant_id = $1 and ancestors ? $3)) \
             order by v.created_at desc, v.id desc limit $4",
            )
            .bind(ctx.tenant)
            .bind(item.id)
            .bind(item.id.to_string())
            .bind(limit)
            .fetch_all(&mut **tx)
            .await?
        }
    };
    Ok(json!({"item": item.id, "activity": rows.into_iter().map(|(id, at, action, name, actor, file, folder, details)| json!({
        "id": id, "at": at, "action": action, "item_name": name, "actor": actor, "file": file, "folder": folder, "details": details,
    })).collect::<Vec<_>>()}))
}

/// `list_comments`: oldest first.
async fn list_comments(tx: &mut Tx, ctx: &Ctx, g: &Grants, p: &Params<'_>) -> Out {
    let f = tree::open_kind(tx, ctx, g, Kind::File, p.req_uuid("file")?, Level::View, false).await?;
    let rows: Vec<(Uuid, Option<String>, String, DateTime<Utc>)> =
        sqlx::query_as("select id, author, body, created_at from e_drive_comment where tenant_id = $1 and file = $2 order by created_at, id limit 1000")
            .bind(ctx.tenant)
            .bind(f.id)
            .fetch_all(&mut **tx)
            .await?;
    let me = files::actor(ctx);
    Ok(json!({"file": f.id, "comments": rows.into_iter().map(|(id, author, body, at)| json!({
        "id": id, "author": author, "body": body, "created_at": at, "mine": author.is_some() && author == me,
    })).collect::<Vec<_>>()}))
}

// ───────────────────────────── folders ─────────────────────────────

/// Creates a folder in `parent` (locked by the caller) named `name` (already free).
pub async fn insert_folder(k: &Kernel, ctx: &Ctx, tx: &mut Tx, parent: &Item, name: &str, colour: Option<&str>) -> Result<Item> {
    if parent.child_ancestors().len() >= MAX_DEPTH {
        return Err(Error::invalid(format!("folders nest at most {MAX_DEPTH} levels deep")));
    }
    let id = Uuid::now_v7();
    let mut doc = Doc::new();
    for (key, v) in [
        ("id", json!(id)),
        ("name", json!(name)),
        ("parent", json!(parent.id)),
        ("root", json!(parent.top())),
        ("ancestors", json!(parent.child_ancestors())),
        ("owner", json!(parent.owner)),
        ("colour", json!(colour)),
    ] {
        doc.insert(key.into(), v);
    }
    k.insert_tx(&elevated(ctx), tx, "DriveFolder", doc).await?;
    reload(tx, ctx.tenant, Kind::Folder, id).await
}

/// `create_folder`: in `parent` (default: the caller's own top folder); a taken name becomes
/// `name (2)` unless `on_conflict` is `fail`.
async fn create_folder(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, space: &Space, p: &Params<'_>) -> Out {
    let name = clean(p.req("name")?)?;
    let colour = colour(p)?;
    let on = files::OnConflict::parse(p.str("on_conflict"))?;
    let parent = p.uuid("parent")?.unwrap_or(space.root);
    let pre = tree::open_kind(tx, ctx, g, Kind::Folder, parent, Level::Edit, false).await?;
    tree::lock_trees(tx, ctx.tenant, &[pre.top()], &[]).await?;
    let parent = tree::open_kind(tx, ctx, g, Kind::Folder, parent, Level::Edit, true).await?;
    let name = match on {
        files::OnConflict::Fail => {
            tree::ensure_free(tx, ctx.tenant, Some(parent.id), &name, None).await?;
            name
        }
        _ => tree::free_name(tx, ctx.tenant, Some(parent.id), &name, true).await?,
    };
    let folder = insert_folder(k, ctx, tx, &parent, &name, colour.as_deref()).await?;
    tree::log(tx, ctx, &folder, "Create Folder", json!({"parent": parent.id})).await?;
    Ok(folder.json(folder.level(g), false))
}

/// Team members from parameters: `[{member, role}]`, each an active user, at most once.
async fn members(tx: &mut Tx, tenant: Uuid, v: Option<&Value>) -> Result<Vec<(String, String)>> {
    let Some(list) = v.filter(|v| !v.is_null()) else { return Ok(vec![]) };
    let list = list.as_array().ok_or_else(|| Error::field("members", "must be a list of {member, role}"))?;
    if list.len() > 500 {
        return Err(Error::field("members", "at most 500 members"));
    }
    let mut out: Vec<(String, String)> = Vec::new();
    for m in list {
        let p = Params(m);
        let email = p.req("member").map_err(|_| Error::field("members", "every member needs a member email"))?.to_lowercase();
        let role = p.str("role").unwrap_or("Viewer").to_string();
        if Level::from_role(&role).is_none() {
            return Err(Error::field("members", "role must be Viewer, Commenter, Editor or Manager"));
        }
        if tree::user_by_email(tx, tenant, &email).await?.is_none() {
            return Err(Error::field("members", format!("{email} is not an active user of this workspace")));
        }
        out.retain(|(e, _)| *e != email);
        out.push((email, role));
    }
    Ok(out)
}

fn quota_param(p: &Params<'_>) -> Result<Option<i64>> {
    match p.int("quota_mb")? {
        Some(q) if q < 0 => Err(Error::field("quota_mb", "must be 0 (unlimited) or more")),
        q => Ok(q),
    }
}

/// `create_team_folder` (Drive administrators): a top folder shared by its members, with its own quota.
async fn create_team_folder(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    if !g.admin {
        return Err(Error::Forbidden("only Drive administrators create team folders".into()));
    }
    let name = clean(p.req("name")?)?;
    let colour = colour(p)?;
    let members = members(tx, ctx.tenant, p.0.get("members")).await?;
    let quota = match quota_param(p)? {
        Some(q) => q,
        None => tree::settings(tx, ctx.tenant).await?.team_quota_mb,
    };
    // Team folder names are unique: one creator or renamer at a time.
    tree::lock_trees(tx, ctx.tenant, &[], &[Uuid::nil()]).await?;
    tree::ensure_free(tx, ctx.tenant, None, &name, None).await?;
    let id = Uuid::now_v7();
    let mut doc = Doc::new();
    for (key, v) in [
        ("id", json!(id)),
        ("name", json!(name)),
        ("is_team", json!(true)),
        ("ancestors", json!([])),
        ("members", json!(members.iter().map(|(m, r)| json!({"member": m, "role": r})).collect::<Vec<_>>())),
        ("quota_mb", json!(quota)),
        ("used_bytes", json!(0)),
        ("colour", json!(colour)),
    ] {
        doc.insert(key.into(), v);
    }
    k.insert_tx(&elevated(ctx), tx, "DriveFolder", doc).await?;
    let folder = reload(tx, ctx.tenant, Kind::Folder, id).await?;
    for (m, role) in &members {
        tell_member(k, tx, ctx, &folder, m, role).await?;
    }
    tree::log(tx, ctx, &folder, "Create Team Folder", json!({"members": members.len(), "quota_mb": quota})).await?;
    Ok(json!({"folder": folder.json(Level::Manage, false), "members": members.iter().map(|(m, r)| json!({"member": m, "role": r})).collect::<Vec<_>>()}))
}

async fn tell_member(k: &Kernel, tx: &mut Tx, ctx: &Ctx, folder: &Item, email: &str, role: &str) -> Result<()> {
    if Some(email) == files::actor(ctx).as_deref() {
        return Ok(());
    }
    if let Some((user, _)) = tree::user_by_email(tx, ctx.tenant, email).await? {
        let by = if ctx.full_name.trim().is_empty() { "Someone".to_string() } else { ctx.full_name.clone() };
        notify::send(tx, ctx.tenant, user, &format!("{by} added you to the team folder \"{}\"", folder.name), Some(role), Some("DriveFolder"), Some(folder.id))
            .await?;
        sharing::mail(k, ctx, tx, email, &format!("{by} added you to a team folder"), &format!("{by} made you a {role} of a team folder in Drive")).await?;
    }
    Ok(())
}

/// `add_team_member` / `remove_team_member` (Manage access to the team folder).
async fn team_member(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>, add: bool) -> Out {
    let folder = tree::open_kind(tx, ctx, g, Kind::Folder, p.req_uuid("folder")?, Level::Manage, true).await?;
    if !folder.is_team {
        return Err(Error::invalid("members belong to team folders; share other folders instead"));
    }
    let email = p.req("member")?.to_lowercase();
    let mut current: Vec<(Uuid, String, String)> =
        sqlx::query_as("select id, member, role from e_drive_folder__members where tenant_id = $1 and parent_id = $2 order by idx")
            .bind(ctx.tenant)
            .bind(folder.id)
            .fetch_all(&mut **tx)
            .await?;
    let role = p.str("role").unwrap_or("Viewer").to_string();
    if add {
        if Level::from_role(&role).is_none() {
            return Err(Error::field("role", "must be Viewer, Commenter, Editor or Manager"));
        }
        if tree::user_by_email(tx, ctx.tenant, &email).await?.is_none() {
            return Err(Error::field("member", format!("{email} is not an active user of this workspace")));
        }
        match current.iter_mut().find(|m| m.1 == email) {
            Some(m) => m.2 = role.clone(),
            None => current.push((Uuid::now_v7(), email.clone(), role.clone())),
        }
    } else {
        let before = current.len();
        current.retain(|m| m.1 != email);
        if current.len() == before {
            return Err(Error::NotFound("team member".into()));
        }
    }
    let rows: Vec<Value> = current.iter().map(|(id, m, r)| json!({"id": id, "member": m, "role": r})).collect();
    let mut doc = Doc::new();
    doc.insert("members".into(), json!(rows));
    k.update_tx(&elevated(ctx), tx, "DriveFolder", folder.id, doc, None).await?;
    if add {
        tell_member(k, tx, ctx, &folder, &email, &role).await?;
    }
    let details = if add { json!({"added": email, "role": role}) } else { json!({"removed": email}) };
    tree::log(tx, ctx, &folder, "Team Members", details).await?;
    Ok(json!({"folder": folder.id, "members": current.iter().map(|(_, m, r)| json!({"member": m, "role": r})).collect::<Vec<_>>()}))
}

/// `set_team_quota` (Drive administrators).
async fn set_team_quota(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    if !g.admin {
        return Err(Error::Forbidden("only Drive administrators set team folder quotas".into()));
    }
    let folder = tree::open_kind(tx, ctx, g, Kind::Folder, p.req_uuid("folder")?, Level::Manage, true).await?;
    if !folder.is_team {
        return Err(Error::invalid("quotas belong to team folders and personal spaces"));
    }
    let quota = quota_param(p)?.ok_or_else(|| Error::field("quota_mb", "is required"))?;
    let mut doc = Doc::new();
    doc.insert("quota_mb".into(), json!(quota));
    k.update_tx(&elevated(ctx), tx, "DriveFolder", folder.id, doc, None).await?;
    tree::log(tx, ctx, &folder, "Quota", json!({"quota_mb": quota})).await?;
    Ok(json!({"folder": folder.id, "quota_mb": quota}))
}

/// Locks the folder `item` sits in (or, for team folders, the team-name lock) before its row.
async fn lock_place(tx: &mut Tx, tenant: Uuid, item: &Item) -> Result<()> {
    match item.parent {
        Some(p) => {
            sqlx::query("select 1 from e_drive_folder where tenant_id = $1 and id = $2 for update").bind(tenant).bind(p).execute(&mut **tx).await?;
        }
        None => tree::lock_trees(tx, tenant, &[], &[Uuid::nil()]).await?,
    }
    Ok(())
}

fn entity_values(pairs: &[(&str, Value)]) -> Doc {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

/// `rename`: a taken name is refused (renames are deliberate).
async fn rename(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let id = p.req_uuid("item")?;
    let name = clean(p.req("name")?)?;
    let pre = tree::open(tx, ctx, g, id, Level::Edit, false).await?;
    lock_place(tx, ctx.tenant, &pre).await?;
    let item = tree::open(tx, ctx, g, id, Level::Edit, true).await?;
    if item.is_top() && !item.is_team {
        return Err(Error::invalid("the top folder of a space cannot be renamed"));
    }
    if item.is_team && item.level(g) < Level::Manage {
        return Err(Error::Forbidden("renaming a team folder needs Manage access".into()));
    }
    files::check_lock(ctx, &item)?;
    if item.name != name {
        tree::ensure_free(tx, ctx.tenant, item.parent, &name, Some(item.id)).await?;
        k.update_tx(&elevated(ctx), tx, item.kind.entity(), item.id, entity_values(&[("name", json!(name))]), None).await?;
        tree::log(tx, ctx, &item, "Rename", json!({"from": item.name, "to": name})).await?;
    }
    let item = reload(tx, ctx.tenant, item.kind, id).await?;
    Ok(item.json(item.level(g), false))
}

/// `set_colour`: a folder's colour (`colour` empty clears it).
async fn set_colour(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let folder = tree::open_kind(tx, ctx, g, Kind::Folder, p.req_uuid("folder")?, Level::Edit, true).await?;
    let colour = colour(p)?;
    k.update_tx(&elevated(ctx), tx, "DriveFolder", folder.id, entity_values(&[("colour", json!(colour))]), None).await?;
    let folder = reload(tx, ctx.tenant, Kind::Folder, folder.id).await?;
    Ok(folder.json(folder.level(g), false))
}

/// `move`: into another folder the caller may edit; refuses cycles and taken names. Moving to
/// another space or team folder needs Manage access to the item and moves its bytes (every
/// version) to the new payer's quota.
async fn move_item(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let id = p.req_uuid("item")?;
    let to = p.req_uuid("to")?;
    let pre = tree::open(tx, ctx, g, id, Level::Edit, false).await?;
    let dest_pre = tree::open_kind(tx, ctx, g, Kind::Folder, to, Level::Edit, false).await?;
    if pre.is_top() {
        return Err(Error::invalid("top folders cannot be moved"));
    }
    let exclusive = if pre.kind == Kind::Folder { vec![pre.top(), dest_pre.top()] } else { vec![] };
    tree::lock_trees(tx, ctx.tenant, &[pre.top(), dest_pre.top()], &exclusive).await?;
    let dest = tree::open_kind(tx, ctx, g, Kind::Folder, to, Level::Edit, true).await?;
    let item = tree::open(tx, ctx, g, id, Level::Edit, true).await?;
    if item.parent == Some(dest.id) {
        return Ok(item.json(item.level(g), false));
    }
    // Another space or team folder takes the item over (owner and quota): that is the owner's call.
    if item.top() != dest.top() && item.level(g) < Level::Manage {
        return Err(Error::Forbidden("moving an item to another space or team folder needs Manage access to it".into()));
    }
    if item.kind == Kind::Folder && (dest.id == item.id || dest.ancestors.contains(&item.id)) {
        return Err(Error::invalid("a folder cannot be moved into itself or into a folder inside it"));
    }
    files::check_lock(ctx, &item)?;
    let prefix = dest.child_ancestors();
    if item.kind == Kind::Folder {
        let deepest: Option<i32> = sqlx::query_scalar("select max(jsonb_array_length(ancestors)) from e_drive_folder where tenant_id = $1 and ancestors ? $2")
            .bind(ctx.tenant)
            .bind(item.id.to_string())
            .fetch_one(&mut **tx)
            .await?;
        let depth = deepest.map_or(prefix.len(), |d| d as usize - item.ancestors.len() + prefix.len());
        if depth >= MAX_DEPTH || prefix.len() >= MAX_DEPTH {
            return Err(Error::invalid(format!("folders nest at most {MAX_DEPTH} levels deep")));
        }
    }
    tree::ensure_free(tx, ctx.tenant, Some(dest.id), &item.name, Some(item.id)).await?;
    let (from, into) = (tree::payer(tx, ctx.tenant, item.top()).await?, tree::payer(tx, ctx.tenant, dest.top()).await?);
    if from != into {
        let bytes = tree::subtree_bytes(tx, ctx.tenant, &item).await?;
        tree::charge(tx, ctx.tenant, into, bytes).await?;
        tree::charge(tx, ctx.tenant, from, -bytes).await?;
    }
    let values =
        entity_values(&[(item.kind.parent_col(), json!(dest.id)), ("root", json!(dest.top())), ("ancestors", json!(prefix)), ("owner", json!(dest.owner))]);
    k.update_tx(&elevated(ctx), tx, item.kind.entity(), item.id, values, None).await?;
    if item.kind == Kind::Folder {
        // Everything inside: replace the enclosing folders up to and including the moved one.
        let mut inner = prefix.clone();
        inner.push(item.id);
        for table in ["e_drive_folder", "e_drive_file"] {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "update {table} a set ancestors = $3::jsonb || coalesce((select jsonb_agg(e order by i) from jsonb_array_elements(a.ancestors) \
                 with ordinality x(e, i) where i > $4), '[]'::jsonb), root = $5, owner = $6, updated_at = now() \
                 where a.tenant_id = $1 and a.ancestors ? $2"
            )))
            .bind(ctx.tenant)
            .bind(item.id.to_string())
            .bind(json!(inner))
            .bind((item.ancestors.len() + 1) as i64)
            .bind(dest.top())
            .bind(&dest.owner)
            .execute(&mut **tx)
            .await?;
        }
    }
    let moved = reload(tx, ctx.tenant, item.kind, item.id).await?;
    tree::log(tx, ctx, &moved, "Move", json!({"from": item.parent, "to": dest.id})).await?;
    Ok(moved.json(moved.level(g), false))
}

/// `copy`: a file, or a folder with everything in it that is out of the trash (current versions
/// only), into a folder the caller may edit; the copy's name avoids clashes (`name (2)`).
async fn copy(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let id = p.req_uuid("item")?;
    let to = p.req_uuid("to")?;
    let src = tree::open(tx, ctx, g, id, Level::View, false).await?;
    let dest_pre = tree::open_kind(tx, ctx, g, Kind::Folder, to, Level::Edit, false).await?;
    if src.kind == Kind::Folder && (dest_pre.id == src.id || dest_pre.ancestors.contains(&src.id)) {
        return Err(Error::invalid("a folder cannot be copied into itself or into a folder inside it"));
    }
    let name = clean(p.str("name").unwrap_or(&src.name))?;
    let (folders, files_in) = match src.kind {
        Kind::File => (vec![], vec![src.clone()]),
        Kind::Folder => {
            let key = src.id.to_string();
            let mut qb = QueryBuilder::new(format!("select {FOLDER_COLS} from e_drive_folder a where a.tenant_id = "));
            qb.push_bind(ctx.tenant).push(" and a.ancestors ? ").push_bind(key.clone());
            let folders = tree::fetch(tx, &mut qb).await?;
            let mut qb = QueryBuilder::new(format!("select {FILE_COLS} from e_drive_file a where a.tenant_id = "));
            qb.push_bind(ctx.tenant).push(" and a.ancestors ? ").push_bind(key).push(" and not a.trashed");
            let files_in = tree::fetch(tx, &mut qb).await?;
            // Nothing in the trash is copied: trashed folders and everything below them stay behind.
            let gone: HashSet<Uuid> = folders.iter().filter(|f| f.trashed).map(|f| f.id).collect();
            let keep = |i: &Item| !i.trashed && !i.ancestors.iter().any(|a| gone.contains(a));
            let mut folders: Vec<Item> = folders.into_iter().filter(keep).collect();
            folders.sort_by_key(|f| f.ancestors.len());
            (folders, files_in.into_iter().filter(keep).collect())
        }
    };
    let bytes: i64 = files_in.iter().map(|f| f.size).sum();
    if folders.len() + files_in.len() + 1 > COPY_ITEMS || bytes > COPY_BYTES {
        return Err(Error::invalid(format!("one copy handles at most {COPY_ITEMS} items and {} MB; copy smaller folders", COPY_BYTES >> 20)));
    }
    let into = tree::payer(tx, ctx.tenant, dest_pre.top()).await?;
    tree::room(tx, ctx.tenant, into, bytes).await?;
    tree::lock_trees(tx, ctx.tenant, &[dest_pre.top()], &[]).await?;
    let dest = tree::open_kind(tx, ctx, g, Kind::Folder, to, Level::Edit, true).await?;
    let mut objects = Vec::new();
    let res = async {
        let name = tree::free_name(tx, ctx.tenant, Some(dest.id), &name, src.kind == Kind::Folder).await?;
        let top = match src.kind {
            Kind::File => files::copy_file(k, ctx, tx, &src, &dest, &name, &mut objects).await?,
            Kind::Folder => {
                let depth = folders.last().map_or(src.ancestors.len(), |f| f.ancestors.len()) - src.ancestors.len();
                if dest.child_ancestors().len() + depth >= MAX_DEPTH {
                    return Err(Error::invalid(format!("folders nest at most {MAX_DEPTH} levels deep")));
                }
                let top = insert_folder(k, ctx, tx, &dest, &name, src.colour.as_deref()).await?;
                let mut made: HashMap<Uuid, Item> = HashMap::from([(src.id, top.clone())]);
                for f in &folders {
                    let parent = f.parent.and_then(|p| made.get(&p)).cloned().ok_or_else(|| Error::internal("copy: parent not copied"))?;
                    let copy = insert_folder(k, ctx, tx, &parent, &f.name, f.colour.as_deref()).await?;
                    made.insert(f.id, copy);
                }
                for f in &files_in {
                    let parent = f.parent.and_then(|p| made.get(&p)).cloned().ok_or_else(|| Error::internal("copy: folder not copied"))?;
                    files::copy_file(k, ctx, tx, f, &parent, &f.name, &mut objects).await?;
                }
                top
            }
        };
        tree::log(tx, ctx, &top, "Copy", json!({"from": src.id, "items": folders.len() + files_in.len() + 1, "bytes": bytes})).await?;
        Ok(top.json(top.level(g), false))
    }
    .await;
    if res.is_err() {
        for o in objects {
            files::discard(k, ctx, o).await;
        }
    }
    res
}

/// `trash`: the item and everything in it leave every listing, search and public link until
/// restored; they still count towards the quota until deleted for good.
async fn trash(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let item = tree::open(tx, ctx, g, p.req_uuid("item")?, Level::Edit, true).await?;
    if item.is_top() && !item.is_team {
        return Err(Error::invalid("the top folder of a space cannot be trashed"));
    }
    if item.is_team && !g.admin {
        return Err(Error::Forbidden("only Drive administrators can trash a team folder".into()));
    }
    files::check_lock(ctx, &item)?;
    let values = entity_values(&[("trashed", json!(true)), ("trashed_at", json!(now())), ("trashed_by", json!(files::actor(ctx)))]);
    k.update_tx(&elevated(ctx), tx, item.kind.entity(), item.id, values, None).await?;
    tree::log(tx, ctx, &item, "Trash", json!({})).await?;
    let item = reload(tx, ctx.tenant, item.kind, item.id).await?;
    Ok(item.json(item.level(g), false))
}

/// `restore`: back where it was; a name taken meanwhile becomes `name (2)`.
async fn restore(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let id = p.req_uuid("item")?;
    let pre = tree::open_trashed(tx, ctx, g, id, Level::Edit, false).await?;
    let gone = tree::trashed_folders(tx, ctx.tenant, &pre.ancestors).await?;
    if let Some(f) = pre.ancestors.iter().find(|a| gone.contains(a)) {
        let name: String =
            sqlx::query_scalar("select name from e_drive_folder where tenant_id = $1 and id = $2").bind(ctx.tenant).bind(f).fetch_one(&mut **tx).await?;
        return Err(Error::invalid(format!("'{}' is inside the folder '{name}', which is in the trash: restore that folder", pre.name)));
    }
    lock_place(tx, ctx.tenant, &pre).await?;
    let item = tree::open_trashed(tx, ctx, g, id, Level::Edit, true).await?;
    let name = tree::free_name(tx, ctx.tenant, item.parent, &item.name, item.kind == Kind::Folder).await?;
    let values = entity_values(&[("trashed", json!(false)), ("trashed_at", Value::Null), ("trashed_by", Value::Null), ("name", json!(name))]);
    k.update_tx(&elevated(ctx), tx, item.kind.entity(), item.id, values, None).await?;
    let restored = reload(tx, ctx.tenant, item.kind, item.id).await?;
    tree::log(tx, ctx, &restored, "Restore", json!({"renamed_from": if name != item.name { Some(&item.name) } else { None }})).await?;
    Ok(restored.json(restored.level(g), false))
}

/// Deletes a trashed item for good with everything in it: versions, stored files, shares, links,
/// stars and comments; the bytes are refunded to the payer. Returns the bytes freed.
pub async fn purge(ctx: &Ctx, tx: &mut Tx, item: &Item) -> Result<i64> {
    // Nothing is created in, moved within or restored into this tree meanwhile.
    tree::lock_trees(tx, ctx.tenant, &[], &[item.top()]).await?;
    let key = item.id.to_string();
    let files: Vec<Uuid> = match item.kind {
        Kind::File => vec![item.id],
        Kind::Folder => {
            sqlx::query_scalar("select id from e_drive_file where tenant_id = $1 and ancestors ? $2").bind(ctx.tenant).bind(&key).fetch_all(&mut **tx).await?
        }
    };
    let mut folders: Vec<(Uuid, i32)> = match item.kind {
        Kind::File => vec![],
        Kind::Folder => {
            sqlx::query_as("select id, jsonb_array_length(ancestors) from e_drive_folder where tenant_id = $1 and (ancestors ? $2 or id = $3)")
                .bind(ctx.tenant)
                .bind(&key)
                .bind(item.id)
                .fetch_all(&mut **tx)
                .await?
        }
    };
    let bytes: i64 = sqlx::query_scalar("select coalesce(sum(size), 0)::bigint from e_drive_file_version where tenant_id = $1 and file = any($2)")
        .bind(ctx.tenant)
        .bind(&files)
        .fetch_one(&mut **tx)
        .await?;
    tree::log(tx, ctx, item, "Delete", json!({"files": files.len(), "folders": folders.len(), "bytes": bytes})).await?;
    files::drop_objects(tx, ctx.tenant, &files, &[]).await?;
    sqlx::query("delete from e_drive_file where tenant_id = $1 and id = any($2)").bind(ctx.tenant).bind(&files).execute(&mut **tx).await?;
    // Deepest first: a folder goes after everything inside it.
    folders.sort_by_key(|f| std::cmp::Reverse(f.1));
    for depth in folders.chunk_by(|a, b| a.1 == b.1) {
        let ids: Vec<Uuid> = depth.iter().map(|f| f.0).collect();
        sqlx::query("delete from e_drive_folder where tenant_id = $1 and id = any($2)").bind(ctx.tenant).bind(&ids).execute(&mut **tx).await?;
    }
    if !item.is_top() {
        let payer = tree::payer(tx, ctx.tenant, item.top()).await?;
        tree::charge(tx, ctx.tenant, payer, -bytes).await?;
    }
    Ok(bytes)
}

/// `delete_forever`: an item in the trash (Manage access).
async fn delete_forever(ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let item = tree::open_trashed(tx, ctx, g, p.req_uuid("item")?, Level::Manage, true).await?;
    let freed = purge(ctx, tx, &item).await?;
    Ok(json!({"deleted": item.id, "freed_bytes": freed}))
}

/// `empty_trash`: everything in the trash the caller manages (optionally in one tree), up to 200 items per call.
async fn empty_trash(ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let items = trash_items(tx, ctx, g, p.uuid("root")?, Level::Manage).await?;
    let mut freed = 0;
    let mut deleted = 0;
    for item in items.iter().take(200) {
        // A folder purged earlier in this loop may have taken this item with it.
        if tree::load_kind(tx, ctx.tenant, item.kind, item.id, true).await?.is_some() {
            freed += purge(ctx, tx, item).await?;
            deleted += 1;
        }
    }
    Ok(json!({"deleted": deleted, "freed_bytes": freed, "more": items.len() > 200}))
}

/// `star` / `unstar`: the caller's own bookmarks.
async fn star(ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>, on: bool) -> Out {
    let item = tree::open(tx, ctx, g, p.req_uuid("item")?, Level::View, false).await?;
    if on {
        let (file, folder) = match item.kind {
            Kind::File => (Some(item.id), None),
            Kind::Folder => (None, Some(item.id)),
        };
        sqlx::query(
            "insert into e_drive_star (tenant_id, id, email, file, folder, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $6) on conflict do nothing",
        )
        .bind(ctx.tenant)
        .bind(Uuid::now_v7())
        .bind(&g.email)
        .bind(file)
        .bind(folder)
        .bind((!ctx.user.is_nil()).then_some(ctx.user))
        .execute(&mut **tx)
        .await?;
    } else {
        sqlx::query("delete from e_drive_star where tenant_id = $1 and email = $2 and (file = $3 or folder = $3)")
            .bind(ctx.tenant)
            .bind(&g.email)
            .bind(item.id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(json!({"item": item.id, "starred": on}))
}

/// `add_comment` (Comment access).
async fn add_comment(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let f = tree::open_kind(tx, ctx, g, Kind::File, p.req_uuid("file")?, Level::Comment, false).await?;
    let body = p.req("body")?;
    if body.chars().count() > 4000 {
        return Err(Error::field("body", "at most 4000 characters"));
    }
    let id = Uuid::now_v7();
    let doc = entity_values(&[("id", json!(id)), ("file", json!(f.id)), ("author", json!(files::actor(ctx))), ("body", json!(body))]);
    k.insert_tx(&elevated(ctx), tx, "DriveComment", doc).await?;
    tree::log(tx, ctx, &f, "Comment", json!({"comment": id})).await?;
    Ok(json!({"id": id, "file": f.id, "author": files::actor(ctx), "body": body}))
}

/// `delete_comment`: its author, or someone with Manage access to the file.
async fn delete_comment(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let id = p.req_uuid("comment")?;
    let row: Option<(Uuid, Option<String>)> =
        sqlx::query_as("select file, author from e_drive_comment where tenant_id = $1 and id = $2").bind(ctx.tenant).bind(id).fetch_optional(&mut **tx).await?;
    let (file, author) = row.ok_or_else(|| Error::NotFound("comment".into()))?;
    let f = tree::open_kind(tx, ctx, g, Kind::File, file, Level::View, false).await.map_err(|_| Error::NotFound("comment".into()))?;
    if author != files::actor(ctx) && f.level(g) < Level::Manage {
        return Err(Error::Forbidden("only its author or someone with Manage access can delete a comment".into()));
    }
    k.delete_tx(&elevated(ctx), tx, "DriveComment", id, None).await?;
    tree::log(tx, ctx, &f, "Delete Comment", json!({"comment": id})).await?;
    Ok(json!({"deleted": id}))
}

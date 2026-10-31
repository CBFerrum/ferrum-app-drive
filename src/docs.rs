//! Documents people edit together live: Drive files of type [`FDOC`] (`.fdoc`), whose content the
//! platform keeps while they are open (`/ws/docs/drive/{file}`, Ferrum's C3) and hands back here as
//! a new version when their editors stop, or every ten minutes while they type. Drive decides who
//! may open one, from the file's access: View and Comment read it, Edit and Manage change it.
//!
//! Everything else about the file is Drive's: sharing, trash, comments, presence, versions. A
//! version of a live document is not restored over it (its editors hold the current state); it is
//! restored as a copy. Uploads never replace a live document's content.
//!
//! Each document's words are kept for search (`drive_doc_words`) whenever a version is written.
//! People and AI agents also reach documents through actions: `create_document` (from Markdown),
//! `read_document` (as Markdown, text or HTML) and `append_to_document`, which adds Markdown as a
//! change everyone with the document open sees at once.

use crate::acl::{Grants, Level};
use crate::content::FDOC;
use crate::files::{self, Content, Expect, OnConflict};
use crate::ops::{Out, Params};
use crate::tree::{self, Item, Kind, Space};
use async_trait::async_trait;
use ferrum_kernel::{Ctx, DocAccess, DocHost, Error, Kernel, Result, Tx, coedit, with_retry};
use serde_json::{Value, json};
use uuid::Uuid;

/// Most of a document's words kept for search.
const WORDS: usize = 200_000;
/// The most Markdown one action takes.
const MAX_MARKDOWN: usize = 1 << 20;

/// This package's name, the one live documents are filed under.
pub const PACKAGE: &str = "drive";

pub struct LiveDocs;

pub fn is_live(file: &Item) -> bool {
    file.content_type.as_deref() == Some(FDOC)
}

/// The refusal for content changes that would go around a live document's editor.
pub fn refuse_replace(file: &Item) -> Result<()> {
    if is_live(file) {
        return Err(Error::invalid(format!("'{}' is edited live: change it in its editor, or upload a new file", file.name)));
    }
    Ok(())
}

/// The live document's current content: as its editors last stored it, else its current version.
pub async fn current(k: &Kernel, ctx: &Ctx, tx: &mut Tx, file: &Item) -> Result<Vec<u8>> {
    if let Some(state) = coedit::state(tx, ctx.tenant, PACKAGE, file.id).await? {
        return Ok(state);
    }
    let (object, ..) = files::version(tx, ctx.tenant, file, None).await?;
    files::read(k, ctx, object).await
}

async fn system(k: &Kernel, tenant: Uuid) -> Result<Ctx> {
    let mut ctx = Ctx::system(tenant, k.registry.schema(tenant).await?);
    ctx.request_id = format!("drive-docs-{}", Uuid::now_v7());
    Ok(ctx)
}

#[async_trait]
impl DocHost for LiveDocs {
    async fn access(&self, k: &Kernel, ctx: &Ctx, doc: Uuid) -> Result<DocAccess> {
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        let g = Grants::load(&mut tx, ctx).await?;
        let file = match tree::open_kind(&mut tx, ctx, &g, Kind::File, doc, Level::View, false).await {
            Ok(f) => f,
            Err(Error::NotFound(_) | Error::Forbidden(_)) => return Ok(DocAccess::None),
            Err(e) => return Err(e),
        };
        tx.commit().await?;
        Ok(match (is_live(&file), file.level(&g) >= Level::Edit) {
            (false, _) => DocAccess::None,
            (true, true) => DocAccess::Write,
            (true, false) => DocAccess::Read,
        })
    }

    /// The current version: empty for a new document, a state for one restored or uploaded.
    async fn initial(&self, k: &Kernel, tenant: Uuid, doc: Uuid) -> Result<Option<Vec<u8>>> {
        let ctx = system(k, tenant).await?;
        let mut tx = k.db.tenant_tx(tenant).await?;
        let file = tree::load_kind(&mut tx, tenant, Kind::File, doc, false).await?.ok_or_else(tree::missing)?;
        let (object, ..) = files::version(&mut tx, tenant, &file, None).await?;
        tx.commit().await?;
        Ok(Some(files::read(k, &ctx, object).await?))
    }

    /// A new version when the content changed, by the first of its editors (the engine's, once
    /// they are gone). A document in the trash keeps its live content until it is restored.
    async fn saved(&self, k: &Kernel, tenant: Uuid, doc: Uuid, state: &[u8], _text: &str, editors: &[Uuid]) -> Result<()> {
        let ctx = match editors.first() {
            Some(user) => match k.load_ctx(tenant, *user, None, format!("drive-docs-{}", Uuid::now_v7())).await {
                Ok(ctx) => ctx,
                Err(_) => system(k, tenant).await?,
            },
            None => system(k, tenant).await?,
        };
        let mut tx = k.db.tenant_tx(tenant).await?;
        let Some(file) = tree::load_kind(&mut tx, tenant, Kind::File, doc, false).await? else { return Ok(()) };
        if !is_live(&file) || file.trashed || tree::in_trash(&mut tx, tenant, &file).await? {
            return Ok(());
        }
        tx.commit().await?;
        let c = Content::new(&file.name, state);
        if file.sha256.as_deref() == Some(c.sha256.as_str()) {
            return Ok(());
        }
        let comment = match editors.len() {
            0 | 1 => "Edited live".to_string(),
            n => format!("Edited live by {n} people"),
        };
        let object = files::store(k, &ctx, &c).await?;
        let res = with_retry(|| async {
            let mut tx = k.db.tenant_tx(tenant).await?;
            let pre = tree::load_kind(&mut tx, tenant, Kind::File, doc, false).await?.ok_or_else(tree::missing)?;
            tree::lock_trees(&mut tx, tenant, &[pre.top()], &[]).await?;
            let file = tree::load_kind(&mut tx, tenant, Kind::File, doc, true).await?.ok_or_else(tree::missing)?;
            files::add_version(k, &ctx, &mut tx, &file, object, &c, Some(&comment), false, Expect::default()).await?;
            tx.commit().await?;
            Ok(())
        })
        .await;
        if res.is_err() {
            files::discard(k, &ctx, object).await;
            return res;
        }
        // Images pasted from other documents become this one's own.
        if let Err(e) = crate::images::adopt(k, &ctx, doc, state).await {
            tracing::warn!(%doc, "drive: keeping a document's pasted images failed: {e}");
        }
        Ok(())
    }
}

/// `restore_version` of a live document: the version as a new document beside it, named after it.
pub async fn restore_as_copy(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, file: &Item, no: i64) -> Result<serde_json::Value> {
    let folder = file.parent.ok_or_else(tree::missing)?;
    let pre = tree::open_kind(tx, ctx, g, Kind::Folder, folder, Level::Edit, false).await?;
    let (object, no, ..) = files::version(tx, ctx.tenant, file, Some(no)).await?;
    let data = files::read(k, ctx, object).await?;
    tree::lock_trees(tx, ctx.tenant, &[pre.top()], &[]).await?;
    let folder = tree::open_kind(tx, ctx, g, Kind::Folder, folder, Level::Edit, true).await?;
    let stem = crate::content::stem(&file.name, false);
    let name = tree::free_name(tx, ctx.tenant, Some(folder.id), &format!("{stem} (version {no}).fdoc"), false).await?;
    let c = Content::new(&name, &data);
    let copy = files::store(k, ctx, &c).await?;
    let res = files::create_file(k, ctx, tx, &folder, &name, copy, &c, Some(&format!("Version {no} of {}", file.name))).await;
    let item = match res {
        Ok(item) => item,
        Err(e) => {
            files::discard(k, ctx, copy).await;
            return Err(e);
        }
    };
    // The version shows the images the document kept (a document keeps every image it was given).
    let mut images = Vec::new();
    if let Err(e) = crate::images::copy(k, ctx, tx, file.id, &item, &mut images).await {
        for object in images {
            files::discard(k, ctx, object).await;
        }
        return Err(e);
    }
    tree::log(tx, ctx, file, "Restore Version", serde_json::json!({"from": no, "copy": item.id})).await?;
    Ok(item.json(item.level(g), false))
}

/// Keeps a live document's words for search, from its content (`state`).
pub async fn index(tx: &mut Tx, tenant: Uuid, file: Uuid, state: &[u8]) -> Result<()> {
    let words: String = coedit::plain_text(&coedit::decode(state)).chars().take(WORDS).collect();
    sqlx::query(
        "insert into drive_doc_words (tenant_id, file, words) values ($1, $2, $3) \
         on conflict (tenant_id, file) do update set words = excluded.words",
    )
    .bind(tenant)
    .bind(file)
    .bind(words)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Keeps the words of live documents that have none yet (made before Drive kept them), a few per
/// run of upkeep.
pub async fn backfill(k: &Kernel, ctx: &Ctx) -> Result<usize> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "select f.id from e_drive_file f where f.tenant_id = $1 and f.content_type = $2 \
         and not exists (select 1 from drive_doc_words w where w.tenant_id = f.tenant_id and w.file = f.id) order by f.id limit 20",
    )
    .bind(ctx.tenant)
    .bind(FDOC)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    for id in &ids {
        let indexed: Result<()> = async {
            let mut tx = k.db.tenant_tx(ctx.tenant).await?;
            let Some(file) = tree::load_kind(&mut tx, ctx.tenant, Kind::File, *id, false).await? else { return Ok(()) };
            let state = current(k, ctx, &mut tx, &file).await?;
            index(&mut tx, ctx.tenant, file.id, &state).await?;
            tx.commit().await?;
            Ok(())
        }
        .await;
        if let Err(e) = indexed {
            tracing::warn!(file = %id, "drive: keeping a document's words failed: {e}");
        }
    }
    Ok(ids.len())
}

/// Markdown as sent: whitespace matters in it, so it is not trimmed like other parameters.
fn markdown<'a>(p: &Params<'a>) -> Result<&'a str> {
    let md = p.0.get("markdown").and_then(Value::as_str).unwrap_or("");
    if md.len() > MAX_MARKDOWN {
        return Err(Error::field("markdown", "at most 1 MB"));
    }
    Ok(md)
}

/// `create_document`: a new live document, `title` (Untitled), from `markdown` (empty), in
/// `folder` (your top folder); a taken name gets a number.
pub async fn create(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, space: &Space, p: &Params<'_>) -> Out {
    let md = markdown(p)?;
    let title = p.str("title").unwrap_or("Untitled");
    let title = if title.to_ascii_lowercase().ends_with(".fdoc") { title[..title.len() - 5].trim() } else { title };
    let state = coedit::encode(&coedit::from_markdown(md));
    let c = Content::new(&format!("{title}.fdoc"), &state);
    let folder = p.uuid("folder")?.unwrap_or(space.root);
    files::upload(k, ctx, tx, g, folder, &c, OnConflict::KeepBoth, None).await
}

fn live_file(file: &Item) -> Result<()> {
    if is_live(file) {
        return Ok(());
    }
    Err(Error::invalid(format!("'{}' is not a document edited live: use download for its content", file.name)))
}

/// `read_document`: a live document as its editors left it (or one of its `version`s), as
/// `markdown` (the default), `text` or `html`.
pub async fn read(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let file = tree::open_kind(tx, ctx, g, Kind::File, p.req_uuid("file")?, Level::View, false).await?;
    live_file(&file)?;
    let format = p.str("format").unwrap_or("markdown");
    if !["markdown", "text", "html"].contains(&format) {
        return Err(Error::field("format", format!("must be markdown, text or html, not {format}")));
    }
    let (state, version) = match p.int("version")? {
        Some(no) => {
            let (object, no, ..) = files::version(tx, ctx.tenant, &file, Some(no)).await?;
            (files::read(k, ctx, object).await?, no)
        }
        None => (current(k, ctx, tx, &file).await?, file.version_no),
    };
    let doc = coedit::decode(&state);
    let content = match format {
        "text" => coedit::plain_text(&doc),
        "html" => coedit::html(&doc),
        _ => coedit::markdown(&doc),
    };
    tree::log(tx, ctx, &file, "Download", json!({"version": version, "format": format})).await?;
    Ok(json!({"file": file.id, "name": file.name, "version": version, "format": format, "content": content}))
}

/// `append_to_document`: `markdown` added at the end of a live document (Edit), as a change
/// everyone who has it open sees at once; its next version includes it.
pub async fn append(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let file = tree::open_kind(tx, ctx, g, Kind::File, p.req_uuid("file")?, Level::Edit, false).await?;
    live_file(&file)?;
    let md = markdown(p)?;
    if md.trim().is_empty() {
        return Err(Error::field("markdown", "is required"));
    }
    // A document nobody has opened live yet starts from its current version.
    let opened: bool = sqlx::query_scalar("select exists (select 1 from coedit_doc where tenant_id = $1 and package = $2 and id = $3)")
        .bind(ctx.tenant)
        .bind(PACKAGE)
        .bind(file.id)
        .fetch_one(&mut **tx)
        .await?;
    let initial = if opened {
        None
    } else {
        let (object, ..) = files::version(tx, ctx.tenant, &file, None).await?;
        Some(files::read(k, ctx, object).await?)
    };
    let change = coedit::append(tx, ctx.tenant, PACKAGE, file.id, initial.as_deref(), md, ctx.user).await?;
    // Found by its new words at once, not at its next version.
    if let Some(state) = coedit::state(tx, ctx.tenant, PACKAGE, file.id).await? {
        index(tx, ctx.tenant, file.id, &state).await?;
    }
    tree::log(tx, ctx, &file, "Edit", json!({"appended": md.chars().count()})).await?;
    Ok(json!({"file": file.id, "name": file.name, "appended": true, "change": change}))
}

//! File content: uploads (new files and versions), downloads, version history, check-out and
//! the stored objects behind them.
//!
//! Bytes live in the platform's file store (`Kernel::store_file`). An upload stores them first,
//! owned by no user (so nobody can delete them through the generic files API), then — in the
//! transaction that creates the version — attaches the platform file to its Drive file, so the
//! platform's own download and attachment endpoints apply Drive File's (administrator-only)
//! access rules. When that transaction fails the stored object is discarded again.

use crate::acl::{Grants, Level};
use crate::content;
use crate::ops::{Out, Params};
use crate::tree::{self, Item, Kind, Space};
use ferrum_domain::util::{elevated, sys};
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, Tx};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Largest content handed back inline by the `download` action (agents and the generic API).
const INLINE_DOWNLOAD: usize = 5 << 20;

/// What a new version is made of.
pub struct Content<'a> {
    pub name: String,
    pub data: &'a [u8],
    pub content_type: &'static str,
    pub sha256: String,
}

impl<'a> Content<'a> {
    pub fn new(name: &str, data: &'a [u8]) -> Content<'a> {
        Content { name: name.to_string(), data, content_type: content::sniff(data, name), sha256: hex::encode(Sha256::digest(data)) }
    }
    fn size(&self) -> i64 {
        self.data.len() as i64
    }
}

/// What a save expects of its file: the editor lock its session holds (WOPI or browser editor)
/// and the version it was made from. While an editor session holds a file, saves that do not
/// hold its lock are refused ([`crate::office::hold`]).
#[derive(Clone, Copy, Default)]
pub struct Expect<'a> {
    pub lock: Option<&'a str>,
    pub base: Option<i64>,
}

/// Stores bytes as a platform file that belongs to nobody yet.
pub(crate) async fn put_object(k: &Kernel, ctx: &Ctx, c: &Content<'_>) -> Result<Uuid> {
    let stored = k.store_file(&sys(ctx), None, &c.name, c.content_type, c.data).await?;
    stored["id"].as_str().and_then(|s| s.parse().ok()).ok_or_else(|| Error::internal("the file store returned no id"))
}

/// Attaches a freshly stored object to its Drive file (inside the transaction creating the version).
pub(crate) async fn attach(tx: &mut Tx, tenant: Uuid, object: Uuid, file: Uuid) -> Result<()> {
    attach_to(tx, tenant, object, "DriveFile", file).await
}

/// Attaches a freshly stored object to a record of Drive's (a file, a template), so the platform's
/// file endpoints apply that entity's access rules to it.
pub(crate) async fn attach_to(tx: &mut Tx, tenant: Uuid, object: Uuid, entity: &str, record: Uuid) -> Result<()> {
    let n = sqlx::query("update file_object set entity = $4, record_id = $3 where tenant_id = $1 and id = $2 and entity is null and record_id is null")
        .bind(tenant)
        .bind(object)
        .bind(record)
        .bind(entity)
        .execute(&mut **tx)
        .await?
        .rows_affected();
    if n != 1 {
        return Err(Error::internal(format!("stored object {object} could not be attached")));
    }
    Ok(())
}

/// Removes an object that never became part of a file, record and bytes (best effort: a failure
/// is only logged — the object is attached to nothing and its id was never handed out).
pub async fn discard(k: &Kernel, ctx: &Ctx, object: Uuid) {
    if let Err(e) = k.remove_file(&sys(ctx), object).await {
        tracing::warn!(%object, "drive: could not discard an unused stored object: {e}");
    }
}

/// Deletes the platform file records of Drive files (`files`) or of single objects (`objects`)
/// in the caller's transaction, so nothing can read them once it commits; their bytes leave
/// storage after the commit (never if it rolls back).
pub async fn drop_objects(tx: &mut Tx, tenant: Uuid, files: &[Uuid], objects: &[Uuid]) -> Result<()> {
    let keys: Vec<String> = sqlx::query_scalar(
        "delete from file_object where tenant_id = $1 and entity = 'DriveFile' and (record_id = any($2) or id = any($3)) returning storage_key",
    )
    .bind(tenant)
    .bind(files)
    .bind(objects)
    .fetch_all(&mut **tx)
    .await?;
    ferrum_kernel::outbox::release_objects(tx, tenant, &keys).await
}

/// Checks size and quota before any bytes are stored, so refused uploads never reach storage.
async fn precheck(tx: &mut Tx, ctx: &Ctx, top: Uuid, bytes: i64) -> Result<()> {
    let s = tree::settings(tx, ctx.tenant).await?;
    if bytes > s.max_upload_bytes {
        return Err(Error::field("file", format!("files are limited to {} MB", s.max_upload_bytes >> 20)));
    }
    let payer = tree::payer(tx, ctx.tenant, top).await?;
    tree::room(tx, ctx.tenant, payer, bytes).await
}

/// How an upload treats a live file of the same name in the folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnConflict {
    /// Keep both: the new file is called `name (2)`.
    KeepBoth,
    /// Add the upload as a new version of the existing file.
    Replace,
    Fail,
}

impl OnConflict {
    pub fn parse(s: Option<&str>) -> Result<OnConflict> {
        Ok(match s.unwrap_or("keep_both") {
            "keep_both" | "rename" => OnConflict::KeepBoth,
            "replace" | "version" => OnConflict::Replace,
            "fail" | "error" => OnConflict::Fail,
            _ => return Err(Error::field("on_conflict", "must be keep_both, replace or fail")),
        })
    }
}

/// Checks an upload into `folder` before any bytes are stored: the name, write access, the size
/// limit and the quota (and, with `Fail`, a clash). Returns the clean name.
pub async fn check_upload(tx: &mut Tx, ctx: &Ctx, g: &Grants, folder: Uuid, c: &Content<'_>, on: OnConflict) -> Result<String> {
    let name = content::clean_name(&c.name).map_err(|m| Error::field("name", m))?;
    let f = tree::open_kind(tx, ctx, g, Kind::Folder, folder, Level::Edit, false).await?;
    if on == OnConflict::Fail {
        tree::ensure_free(tx, ctx.tenant, Some(f.id), &name, None).await?;
    }
    precheck(tx, ctx, f.top(), c.size()).await?;
    Ok(name)
}

/// Stores the bytes of an upload; the Site does this holding no transaction.
pub async fn store(k: &Kernel, ctx: &Ctx, c: &Content<'_>) -> Result<Uuid> {
    put_object(k, ctx, c).await
}

/// Turns a stored object into a new file in `folder` (or, with `Replace`, a new version of the
/// same-named file), re-checking everything under the folder's lock.
#[allow(clippy::too_many_arguments)]
pub async fn commit_upload(
    k: &Kernel,
    ctx: &Ctx,
    tx: &mut Tx,
    g: &Grants,
    folder: Uuid,
    c: &Content<'_>,
    object: Uuid,
    on: OnConflict,
    comment: Option<&str>,
) -> Result<Value> {
    let name = content::clean_name(&c.name).map_err(|m| Error::field("name", m))?;
    let pre = tree::open_kind(tx, ctx, g, Kind::Folder, folder, Level::Edit, false).await?;
    tree::lock_trees(tx, ctx.tenant, &[pre.top()], &[]).await?;
    let f = tree::open_kind(tx, ctx, g, Kind::Folder, folder, Level::Edit, true).await?;
    let same: Option<Uuid> = sqlx::query_scalar("select id from e_drive_file where tenant_id = $1 and folder = $2 and not trashed and lower(name) = lower($3)")
        .bind(ctx.tenant)
        .bind(f.id)
        .bind(&name)
        .fetch_optional(&mut **tx)
        .await?;
    let name = match (on, same) {
        (OnConflict::Replace, Some(existing)) => {
            let file = tree::open_kind(tx, ctx, g, Kind::File, existing, Level::Edit, true).await?;
            crate::docs::refuse_replace(&file)?;
            let item = add_version(k, ctx, tx, &file, object, c, comment, false, Expect::default()).await?;
            return Ok(item.json(item.level(g), false));
        }
        (OnConflict::KeepBoth, _) => tree::free_name(tx, ctx.tenant, Some(f.id), &name, false).await?,
        _ => {
            tree::ensure_free(tx, ctx.tenant, Some(f.id), &name, None).await?;
            name
        }
    };
    let item = create_file(k, ctx, tx, &f, &name, object, c, comment).await?;
    Ok(item.json(item.level(g), false))
}

/// An upload in one transaction (actions): check, store, commit — or discard the stored bytes.
pub async fn upload(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, folder: Uuid, c: &Content<'_>, on: OnConflict, comment: Option<&str>) -> Result<Value> {
    check_upload(tx, ctx, g, folder, c, on).await?;
    let object = put_object(k, ctx, c).await?;
    let res = commit_upload(k, ctx, tx, g, folder, c, object, on, comment).await;
    if res.is_err() {
        discard(k, ctx, object).await;
    }
    res
}

/// Creates a file with its first version in folder `f` (locked by the caller), charging its payer.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn create_file(
    k: &Kernel,
    ctx: &Ctx,
    tx: &mut Tx,
    f: &Item,
    name: &str,
    object: Uuid,
    c: &Content<'_>,
    comment: Option<&str>,
) -> Result<Item> {
    let payer = tree::payer(tx, ctx.tenant, f.top()).await?;
    tree::charge(tx, ctx.tenant, payer, c.size()).await?;
    let id = Uuid::now_v7();
    let mut doc = Doc::new();
    for (key, v) in [
        ("id", json!(id)),
        ("name", json!(name)),
        ("folder", json!(f.id)),
        ("root", json!(f.top())),
        ("ancestors", json!(f.child_ancestors())),
        ("owner", json!(f.owner)),
        ("file_type", json!(content::file_type(c.content_type))),
        ("content_type", json!(c.content_type)),
        ("size", json!(c.size())),
        ("sha256", json!(c.sha256)),
        ("version_no", json!(1)),
        ("modified_at", json!(crate::now())),
        ("modified_by", json!(actor(ctx))),
    ] {
        doc.insert(key.into(), v);
    }
    k.insert_tx(&elevated(ctx), tx, "DriveFile", doc).await?;
    let version = insert_version(k, ctx, tx, id, 1, object, c, comment).await?;
    if c.content_type == content::FDOC {
        crate::docs::index(tx, ctx.tenant, id, c.data).await?;
    }
    let mut v = Doc::new();
    v.insert("current_version".into(), json!(version));
    k.set_values_tx(ctx, tx, "DriveFile", id, v).await?;
    attach(tx, ctx.tenant, object, id).await?;
    let item = tree::load_kind(tx, ctx.tenant, Kind::File, id, false).await?.ok_or_else(|| Error::internal("file vanished"))?;
    tree::log(tx, ctx, &item, "Upload", json!({"version": 1, "size": c.size()})).await?;
    Ok(item)
}

#[allow(clippy::too_many_arguments)]
async fn insert_version(k: &Kernel, ctx: &Ctx, tx: &mut Tx, file: Uuid, no: i64, object: Uuid, c: &Content<'_>, comment: Option<&str>) -> Result<Uuid> {
    let id = Uuid::now_v7();
    let mut doc = Doc::new();
    for (key, v) in [
        ("id", json!(id)),
        ("file", json!(file)),
        ("version_no", json!(no)),
        ("stored_file", json!(object)),
        ("size", json!(c.size())),
        ("sha256", json!(c.sha256)),
        ("content_type", json!(c.content_type)),
        ("author", json!(actor(ctx))),
        ("comment", json!(comment.map(|s| s.chars().take(500).collect::<String>()))),
    ] {
        doc.insert(key.into(), v);
    }
    k.insert_tx(&elevated(ctx), tx, "DriveFileVersion", doc).await?;
    Ok(id)
}

/// The caller's email for `*_by` fields (empty for the engine).
pub fn actor(ctx: &Ctx) -> Option<String> {
    (!ctx.user.is_nil()).then(|| ctx.email.trim().to_lowercase())
}

/// Refuses changes to a file someone else has checked out.
pub fn check_lock(ctx: &Ctx, file: &Item) -> Result<()> {
    match &file.locked_by {
        Some(holder) if Some(holder.as_str()) != actor(ctx).as_deref() => {
            Err(Error::Conflict(format!("'{}' is checked out by {holder}; it can be changed after they check it in", file.name)))
        }
        _ => Ok(()),
    }
}

/// Adds a version to `file` (locked by the caller) and prunes old versions beyond the limit.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn add_version(
    k: &Kernel,
    ctx: &Ctx,
    tx: &mut Tx,
    file: &Item,
    object: Uuid,
    c: &Content<'_>,
    comment: Option<&str>,
    check_in: bool,
    expect: Expect<'_>,
) -> Result<Item> {
    check_lock(ctx, file)?;
    crate::office::hold(tx, ctx, file, expect.lock).await?;
    if let Some(base) = expect.base
        && base != file.version_no
    {
        return Err(Error::Conflict(format!(
            "'{}' changed since it was opened (version {base}, now {}): save a copy, or replace it",
            file.name, file.version_no
        )));
    }
    let payer = tree::payer(tx, ctx.tenant, file.top()).await?;
    tree::charge(tx, ctx.tenant, payer, c.size()).await?;
    let no = file.version_no + 1;
    let version = insert_version(k, ctx, tx, file.id, no, object, c, comment).await?;
    if c.content_type == content::FDOC {
        crate::docs::index(tx, ctx.tenant, file.id, c.data).await?;
    }
    let mut doc = Doc::new();
    for (key, v) in [
        ("file_type", json!(content::file_type(c.content_type))),
        ("content_type", json!(c.content_type)),
        ("size", json!(c.size())),
        ("sha256", json!(c.sha256)),
        ("version_no", json!(no)),
        ("current_version", json!(version)),
        ("modified_at", json!(crate::now())),
        ("modified_by", json!(actor(ctx))),
    ] {
        doc.insert(key.into(), v);
    }
    if check_in {
        doc.insert("locked_by".into(), Value::Null);
        doc.insert("locked_at".into(), Value::Null);
    }
    k.update_tx(&elevated(ctx), tx, "DriveFile", file.id, doc, None).await?;
    attach(tx, ctx.tenant, object, file.id).await?;
    let item = tree::load_kind(tx, ctx.tenant, Kind::File, file.id, false).await?.ok_or_else(|| Error::internal("file vanished"))?;
    tree::log(tx, ctx, &item, if check_in { "Check In" } else { "New Version" }, json!({"version": no, "size": c.size()})).await?;
    prune(tx, ctx, &item).await?;
    Ok(item)
}

/// Removes the oldest versions beyond the workspace's limit (never the current one) and refunds them.
async fn prune(tx: &mut Tx, ctx: &Ctx, file: &Item) -> Result<()> {
    let keep = tree::settings(tx, ctx.tenant).await?.max_versions;
    if keep == 0 {
        return Ok(());
    }
    let old: Vec<(Uuid, Option<String>, Option<i64>)> =
        sqlx::query_as("select id, stored_file, size from e_drive_file_version where tenant_id = $1 and file = $2 order by version_no desc offset $3")
            .bind(ctx.tenant)
            .bind(file.id)
            .bind(keep)
            .fetch_all(&mut **tx)
            .await?;
    if old.is_empty() {
        return Ok(());
    }
    let ids: Vec<Uuid> = old.iter().map(|o| o.0).collect();
    let objects: Vec<Uuid> = old.iter().filter_map(|o| o.1.as_deref().and_then(|s| s.parse().ok())).collect();
    let bytes: i64 = old.iter().map(|o| o.2.unwrap_or(0)).sum();
    sqlx::query("delete from e_drive_file_version where tenant_id = $1 and id = any($2)").bind(ctx.tenant).bind(&ids).execute(&mut **tx).await?;
    drop_objects(tx, ctx.tenant, &[], &objects).await?;
    let payer = tree::payer(tx, ctx.tenant, file.top()).await?;
    tree::charge(tx, ctx.tenant, payer, -bytes).await
}

/// Checks a new version of `file` before any bytes are stored (for check-in: the file must be
/// checked out, by the caller).
pub async fn check_version(tx: &mut Tx, ctx: &Ctx, g: &Grants, file: Uuid, c: &Content<'_>, check_in: bool, expect: Expect<'_>) -> Result<()> {
    let f = tree::open_kind(tx, ctx, g, Kind::File, file, Level::Edit, false).await?;
    crate::docs::refuse_replace(&f)?;
    check_lock(ctx, &f)?;
    crate::office::check_editor_lock(tx, ctx.tenant, &f, expect.lock).await?;
    if check_in && f.locked_by.is_none() {
        return Err(Error::invalid(format!("'{}' is not checked out", f.name)));
    }
    precheck(tx, ctx, f.top(), c.size()).await
}

/// Turns a stored object into the newest version of `file`, re-checked under the file's lock.
#[allow(clippy::too_many_arguments)]
pub async fn commit_version(
    k: &Kernel,
    ctx: &Ctx,
    tx: &mut Tx,
    g: &Grants,
    file: Uuid,
    c: &Content<'_>,
    object: Uuid,
    comment: Option<&str>,
    check_in: bool,
    expect: Expect<'_>,
) -> Result<Value> {
    let pre = tree::open_kind(tx, ctx, g, Kind::File, file, Level::Edit, false).await?;
    tree::lock_trees(tx, ctx.tenant, &[pre.top()], &[]).await?;
    let f = tree::open_kind(tx, ctx, g, Kind::File, file, Level::Edit, true).await?;
    if check_in && f.locked_by.is_none() {
        return Err(Error::invalid(format!("'{}' is not checked out", f.name)));
    }
    let item = add_version(k, ctx, tx, &f, object, c, comment, check_in, expect).await?;
    Ok(item.json(item.level(g), false))
}

/// A new version in one transaction (actions): check, store, commit — or discard the stored bytes.
pub async fn upload_version(
    k: &Kernel,
    ctx: &Ctx,
    tx: &mut Tx,
    g: &Grants,
    file: Uuid,
    c: &Content<'_>,
    comment: Option<&str>,
    check_in: bool,
    expect: Expect<'_>,
) -> Result<Value> {
    check_version(tx, ctx, g, file, c, check_in, expect).await?;
    let object = put_object(k, ctx, c).await?;
    let res = commit_version(k, ctx, tx, g, file, c, object, comment, check_in, expect).await;
    if res.is_err() {
        discard(k, ctx, object).await;
    }
    res
}

/// One version's stored object: `(object, version_no, size, sha256, content_type)`.
pub(crate) async fn version(tx: &mut Tx, tenant: Uuid, file: &Item, no: Option<i64>) -> Result<(Uuid, i64, i64, Option<String>, Option<String>)> {
    let no = no.unwrap_or(file.version_no);
    let row: Option<(Option<String>, Option<i64>, Option<String>, Option<String>)> =
        sqlx::query_as("select stored_file, size, sha256, content_type from e_drive_file_version where tenant_id = $1 and file = $2 and version_no = $3")
            .bind(tenant)
            .bind(file.id)
            .bind(no)
            .fetch_optional(&mut **tx)
            .await?;
    let (object, size, sha, ctype) = row.ok_or_else(|| Error::NotFound(format!("version {no}")))?;
    let object = object.and_then(|o| o.parse().ok()).ok_or_else(|| Error::Unavailable(format!("version {no} has no stored content")))?;
    Ok((object, no, size.unwrap_or(0), sha, ctype))
}

/// What a download serves.
pub struct Download {
    pub file: Item,
    pub content_type: String,
    pub version: i64,
    pub object: Uuid,
    pub sha256: Option<String>,
}

/// Authorises a download of a file version; the caller reads the bytes, then [`logged`]s it.
pub async fn prepare_download(tx: &mut Tx, ctx: &Ctx, g: &Grants, file: Uuid, no: Option<i64>) -> Result<Download> {
    let f = tree::open_kind(tx, ctx, g, Kind::File, file, Level::View, false).await?;
    let (object, no, _, sha, ctype) = version(tx, ctx.tenant, &f, no).await?;
    Ok(Download { file: f, content_type: ctype.unwrap_or_else(|| "application/octet-stream".into()), version: no, object, sha256: sha })
}

/// Records a completed download in the activity log.
pub async fn logged(tx: &mut Tx, ctx: &Ctx, d: &Download) -> Result<()> {
    tree::log(tx, ctx, &d.file, "Download", json!({"version": d.version})).await
}

/// The bytes of a stored object.
pub async fn read(k: &Kernel, ctx: &Ctx, object: Uuid) -> Result<Vec<u8>> {
    Ok(k.read_file(&sys(ctx), object).await?.2)
}

/// `download` action: the content inline (base64, and as text for text files) up to 5 MB.
pub async fn download(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let file = p.req_uuid("file")?;
    let d = prepare_download(tx, ctx, g, file, p.int("version")?).await?;
    let size: Option<i64> = sqlx::query_scalar("select size from e_drive_file_version where tenant_id = $1 and file = $2 and version_no = $3")
        .bind(ctx.tenant)
        .bind(file)
        .bind(d.version)
        .fetch_one(&mut **tx)
        .await?;
    if size.unwrap_or(0) > INLINE_DOWNLOAD as i64 {
        return Err(Error::invalid(format!(
            "'{}' is larger than 5 MB: download it from GET /api/app/drive/files/{file}/content?version={}",
            d.file.name, d.version
        )));
    }
    let live = crate::docs::is_live(&d.file);
    let data = if live && p.int("version")?.is_none() { crate::docs::current(k, ctx, tx, &d.file).await? } else { read(k, ctx, d.object).await? };
    logged(tx, ctx, &d).await?;
    use base64::Engine as _;
    let text = if live {
        Some(ferrum_kernel::coedit::plain_text(&ferrum_kernel::coedit::decode(&data)))
    } else if content::is_textual(&d.content_type) {
        String::from_utf8(data.clone()).ok()
    } else {
        None
    };
    Ok(json!({"file": file, "name": d.file.name, "version": d.version, "content_type": d.content_type, "size": data.len(), "sha256": d.sha256,
              "content_base64": base64::engine::general_purpose::STANDARD.encode(&data), "text": text}))
}

/// `list_versions`: newest first.
pub async fn list_versions(tx: &mut Tx, ctx: &Ctx, g: &Grants, p: &Params<'_>) -> Out {
    let f = tree::open_kind(tx, ctx, g, Kind::File, p.req_uuid("file")?, Level::View, false).await?;
    let rows: Vec<(Uuid, i64, Option<i64>, Option<String>, Option<String>, Option<String>, Option<String>, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "select id, version_no, size, sha256, content_type, author, comment, created_at from e_drive_file_version \
         where tenant_id = $1 and file = $2 order by version_no desc",
    )
    .bind(ctx.tenant)
    .bind(f.id)
    .fetch_all(&mut **tx)
    .await?;
    let versions: Vec<Value> = rows
        .into_iter()
        .map(|(id, no, size, sha, ctype, author, comment, at)| {
            json!({"id": id, "version": no, "size": size.unwrap_or(0), "sha256": sha, "content_type": ctype, "author": author, "comment": comment,
                   "created_at": at, "current": no == f.version_no})
        })
        .collect();
    Ok(json!({"file": f.id, "name": f.name, "versions": versions}))
}

/// `restore_version`: the old content becomes the newest version (history is never rewritten).
pub async fn restore_version(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let file = p.req_uuid("file")?;
    let no = p.int("version")?.ok_or_else(|| Error::field("version", "is required"))?;
    let f = tree::open_kind(tx, ctx, g, Kind::File, file, Level::Edit, false).await?;
    check_lock(ctx, &f)?;
    if crate::docs::is_live(&f) {
        return crate::docs::restore_as_copy(k, ctx, tx, g, &f, no).await;
    }
    if no == f.version_no {
        return Err(Error::invalid(format!("version {no} is already the current version")));
    }
    let (object, no, _, _, _) = version(tx, ctx.tenant, &f, Some(no)).await?;
    let data = read(k, ctx, object).await?;
    let c = Content::new(&f.name, &data);
    let comment = format!("Restored from version {no}");
    let out = upload_version(k, ctx, tx, g, file, &c, Some(&comment), false, Expect::default()).await?;
    let item = tree::load_kind(tx, ctx.tenant, Kind::File, file, false).await?.ok_or_else(tree::missing)?;
    tree::log(tx, ctx, &item, "Restore Version", json!({"from": no, "version": item.version_no})).await?;
    Ok(out)
}

/// `check_out`: reserves the file for the caller; others cannot change it until it is checked in.
pub async fn check_out(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let f = tree::open_kind(tx, ctx, g, Kind::File, p.req_uuid("file")?, Level::Edit, true).await?;
    if crate::docs::is_live(&f) {
        return Err(Error::invalid(format!("'{}' is edited live: everyone with access edits it together", f.name)));
    }
    check_lock(ctx, &f)?;
    if f.locked_by.is_none() {
        let mut doc = Doc::new();
        doc.insert("locked_by".into(), json!(actor(ctx)));
        doc.insert("locked_at".into(), json!(crate::now()));
        k.update_tx(&elevated(ctx), tx, "DriveFile", f.id, doc, None).await?;
        tree::log(tx, ctx, &f, "Check Out", json!({})).await?;
    }
    let item = tree::load_kind(tx, ctx.tenant, Kind::File, f.id, false).await?.ok_or_else(tree::missing)?;
    Ok(item.json(item.level(g), false))
}

/// `check_in` without new content: releases the file. Its holder may always; someone with Manage
/// access may break another person's check-out with `force`.
pub async fn check_in(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let file = p.req_uuid("file")?;
    if let Some(c) = p.content()? {
        let f = tree::open_kind(tx, ctx, g, Kind::File, file, Level::Edit, false).await?;
        let c = Content::new(&f.name, &c);
        return upload_version(k, ctx, tx, g, file, &c, p.str("comment"), true, Expect::default()).await;
    }
    let f = tree::open_kind(tx, ctx, g, Kind::File, file, Level::View, true).await?;
    let Some(holder) = f.locked_by.clone() else { return Err(Error::invalid(format!("'{}' is not checked out", f.name))) };
    let mine = Some(holder.as_str()) == actor(ctx).as_deref();
    let forced = p.flag("force") && f.level(g) >= Level::Manage;
    if !(mine || forced) {
        return Err(Error::Conflict(format!("'{}' is checked out by {holder}; only they, or someone with Manage access using force, can check it in", f.name)));
    }
    if mine && f.level(g) < Level::Edit {
        return Err(Error::Forbidden("this needs Edit access".into()));
    }
    let mut doc = Doc::new();
    doc.insert("locked_by".into(), Value::Null);
    doc.insert("locked_at".into(), Value::Null);
    k.update_tx(&elevated(ctx), tx, "DriveFile", f.id, doc, None).await?;
    tree::log(tx, ctx, &f, "Check In", json!({"forced_from": if mine { None } else { Some(holder) }})).await?;
    let item = tree::load_kind(tx, ctx.tenant, Kind::File, f.id, false).await?.ok_or_else(tree::missing)?;
    Ok(item.json(item.level(g), false))
}

/// `upload` action: a new file from `content_base64` or `text`.
pub async fn upload_action(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, space: &Space, p: &Params<'_>) -> Out {
    let name = p.req("name")?;
    let data = p.content()?.ok_or_else(|| Error::field("content_base64", "send the file as content_base64 or text"))?;
    let c = Content::new(name, &data);
    let folder = p.uuid("folder")?.unwrap_or(space.root);
    upload(k, ctx, tx, g, folder, &c, OnConflict::parse(p.str("on_conflict"))?, p.str("comment")).await
}

/// `upload_version` action.
pub async fn upload_version_action(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let file = p.req_uuid("file")?;
    let data = p.content()?.ok_or_else(|| Error::field("content_base64", "send the file as content_base64 or text"))?;
    let f = tree::open_kind(tx, ctx, g, Kind::File, file, Level::Edit, false).await?;
    let c = Content::new(&f.name, &data);
    upload_version(k, ctx, tx, g, file, &c, p.str("comment"), false, Expect::default()).await
}

/// Copies a file's current content into a new file in `dest` (locked by the caller).
pub async fn copy_file(k: &Kernel, ctx: &Ctx, tx: &mut Tx, src: &Item, dest: &Item, name: &str, objects: &mut Vec<Uuid>) -> Result<Item> {
    // A live document is copied as its editors left it, not as last saved.
    let data = if crate::docs::is_live(src) {
        crate::docs::current(k, ctx, tx, src).await?
    } else {
        let (object, _, _, _, _) = version(tx, ctx.tenant, src, None).await?;
        read(k, ctx, object).await?
    };
    let c = Content::new(name, &data);
    let copy = put_object(k, ctx, &c).await?;
    objects.push(copy);
    let item = create_file(k, ctx, tx, dest, name, copy, &c, Some(&format!("Copied from {}", src.name))).await?;
    // A copy of a document shows the same images: copies of them, its own.
    if crate::docs::is_live(src) {
        crate::images::copy(k, ctx, tx, src.id, &item, objects).await?;
    }
    Ok(item)
}

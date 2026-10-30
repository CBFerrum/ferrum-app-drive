//! Documents people edit together live: Drive files of type [`FDOC`] (`.fdoc`), whose content the
//! platform keeps while they are open (`/ws/docs/drive/{file}`, Ferrum's C3) and hands back here as
//! a new version when their editors stop, or every ten minutes while they type. Drive decides who
//! may open one, from the file's access: View and Comment read it, Edit and Manage change it.
//!
//! Everything else about the file is Drive's: sharing, trash, comments, presence, versions. A
//! version of a live document is not restored over it (its editors hold the current state); it is
//! restored as a copy. Uploads never replace a live document's content.

use crate::acl::{Grants, Level};
use crate::content::FDOC;
use crate::files::{self, Content, Expect};
use crate::tree::{self, Item, Kind};
use async_trait::async_trait;
use ferrum_kernel::{Ctx, DocAccess, DocHost, Error, Kernel, Result, Tx, coedit, with_retry};
use uuid::Uuid;

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
        }
        res
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
    tree::log(tx, ctx, file, "Restore Version", serde_json::json!({"from": no, "copy": item.id})).await?;
    Ok(item.json(item.level(g), false))
}

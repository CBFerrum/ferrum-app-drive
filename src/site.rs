//! HTTP endpoints. Signed in (`/api/app/drive/...`, Drive users): the caller's space, the
//! read-only actions as `GET /{action}`, raw-body uploads (new files and versions) and downloads.
//! Public (`/api/site/{tenant}/drive/...`): public links, see [`crate::sharing`].

use crate::acl::Grants;
use crate::files::{self, Content, OnConflict};
use crate::ops::{self, Params};
use crate::tree;
use async_trait::async_trait;
use ferrum_kernel::{Ctx, Error, Kernel, Result, Site, SiteRequest, SiteResponse, with_retry};
use serde_json::{Value, json};
use uuid::Uuid;

pub struct DriveSite;

#[async_trait]
impl Site for DriveSite {
    /// Uploads arrive as the raw request body; the server caps every body at 32 MB and the
    /// workspace setting (at most that) decides per upload.
    fn max_body(&self) -> usize {
        32 << 20
    }

    async fn handle(&self, k: &Kernel, req: SiteRequest) -> Result<SiteResponse> {
        let path: Vec<&str> = req.path.split('/').filter(|p| !p.is_empty()).collect();
        match &req.user {
            None => crate::sharing::public(k, &req, &path).await,
            Some(ctx) => app(k, ctx, &req, &path).await,
        }
    }
}

fn id(seg: &str) -> Result<Uuid> {
    seg.parse().map_err(|_| tree::missing())
}

async fn app(k: &Kernel, ctx: &Ctx, req: &SiteRequest, path: &[&str]) -> Result<SiteResponse> {
    let q = Value::Object(req.query.clone());
    let p = Params(&q);
    let out = match (req.method.as_str(), path) {
        ("GET", ["space"]) => {
            let s = tree::ensure_space(k, ctx).await?;
            json!({"id": s.id, "owner": s.owner, "root_folder": s.root})
        }
        ("GET", [action]) if ops::READS.contains(action) => {
            let space = tree::ensure_space(k, ctx).await?;
            with_retry(|| async {
                let mut tx = k.db.tenant_tx(ctx.tenant).await?;
                let out = ops::run(k, ctx, &mut tx, &space, action, &q).await?;
                tx.commit().await?;
                Ok(out)
            })
            .await?
        }
        ("POST", ["upload"]) => {
            let space = tree::ensure_space(k, ctx).await?;
            let folder = p.uuid("folder")?.unwrap_or(space.root);
            let on = OnConflict::parse(p.str("on_conflict"))?;
            let c = Content::new(p.req("name")?, &req.body);
            let mut tx = k.db.tenant_tx(ctx.tenant).await?;
            let g = Grants::load(&mut tx, ctx).await?;
            files::check_upload(&mut tx, ctx, &g, folder, &c, on).await?;
            tx.commit().await?;
            let object = files::store(k, ctx, &c).await?;
            let res = with_retry(|| async {
                let mut tx = k.db.tenant_tx(ctx.tenant).await?;
                let g = Grants::load(&mut tx, ctx).await?;
                let out = files::commit_upload(k, ctx, &mut tx, &g, folder, &c, object, on, p.str("comment")).await?;
                tx.commit().await?;
                Ok(out)
            })
            .await;
            if res.is_err() {
                files::discard(k, ctx, object).await;
            }
            return Ok(SiteResponse::json(201, &res?));
        }
        ("POST", ["files", file, "versions"]) => {
            let file = id(file)?;
            let check_in = p.flag("check_in");
            let mut tx = k.db.tenant_tx(ctx.tenant).await?;
            let g = Grants::load(&mut tx, ctx).await?;
            let f = tree::open_kind(&mut tx, ctx, &g, tree::Kind::File, file, crate::acl::Level::Edit, false).await?;
            let c = Content::new(&f.name, &req.body);
            files::check_version(&mut tx, ctx, &g, file, &c, check_in).await?;
            tx.commit().await?;
            let object = files::store(k, ctx, &c).await?;
            let res = with_retry(|| async {
                let mut tx = k.db.tenant_tx(ctx.tenant).await?;
                let g = Grants::load(&mut tx, ctx).await?;
                let out = files::commit_version(k, ctx, &mut tx, &g, file, &c, object, p.str("comment"), check_in).await?;
                tx.commit().await?;
                Ok(out)
            })
            .await;
            if res.is_err() {
                files::discard(k, ctx, object).await;
            }
            return Ok(SiteResponse::json(201, &res?));
        }
        ("GET", ["files", file, "content"]) => return download(k, ctx, id(file)?, &p).await,
        _ => return Err(Error::NotFound("endpoint".into())),
    };
    Ok(SiteResponse::json(200, &out))
}

/// `GET /files/{id}/content?version=&inline=1`: images and PDFs may be shown inline; everything
/// else downloads, and types a browser could run arrive as opaque bytes.
async fn download(k: &Kernel, ctx: &Ctx, file: Uuid, p: &Params<'_>) -> Result<SiteResponse> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let g = Grants::load(&mut tx, ctx).await?;
    let d = files::prepare_download(&mut tx, ctx, &g, file, p.int("version")?).await?;
    tx.commit().await?;
    let data = files::read(k, ctx, d.object).await?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    files::logged(&mut tx, ctx, &d).await?;
    tx.commit().await?;
    let preview = p.flag("inline") && crate::content::inline_ok(&d.content_type);
    let ctype = if preview { d.content_type.clone() } else { crate::content::served_type(&d.content_type).to_string() };
    let mut headers = vec![
        ("content-disposition".to_string(), crate::content::disposition(preview, &d.file.name)),
        ("x-content-type-options".into(), "nosniff".into()),
        ("content-security-policy".into(), "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox".into()),
        ("cache-control".into(), "private, no-store".into()),
        ("x-drive-version".into(), d.version.to_string()),
    ];
    if let Some(sha) = &d.sha256 {
        headers.push(("etag".into(), format!("\"{sha}\"")));
    }
    Ok(SiteResponse { status: 200, content_type: ctype, headers, body: data })
}

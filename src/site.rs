//! HTTP endpoints. Signed in (`/api/app/drive/...`, Drive users): the caller's space, the
//! read-only actions as `GET /{action}`, raw-body uploads (new files and versions), downloads, new
//! blank documents, and editor sessions of a file with their locks ([`crate::office`]). Public
//! (`/api/site/{tenant}/drive/...`): public links ([`crate::sharing`]) and the WOPI endpoints the
//! editor server calls.

use crate::acl::Grants;
use crate::files::{self, Content, OnConflict};
use crate::ops::{self, Params};
use crate::tree;
use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ferrum_kernel::{Ctx, Error, Kernel, Result, Site, SiteRequest, SiteResponse, with_retry};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

pub struct DriveSite;

#[async_trait]
impl Site for DriveSite {
    /// The JSON routes; files take [`max_file_bytes`] (`max_body_for`).
    fn max_body(&self) -> usize {
        1 << 20
    }

    /// Uploads, new versions and the editor's saves arrive as the raw request body, up to the
    /// operator's file limit; the workspace setting (at most that) decides per upload.
    fn max_body_for(&self, method: &str, path: &str) -> usize {
        let p: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        match (method, p.as_slice()) {
            ("POST", ["upload"] | ["files", _, "versions"] | ["wopi", "files", _, "contents"]) => max_file_bytes(),
            _ => self.max_body(),
        }
    }

    async fn handle(&self, k: &Kernel, req: SiteRequest) -> Result<SiteResponse> {
        let path: Vec<&str> = req.path.split('/').filter(|p| !p.is_empty()).collect();
        match &req.user {
            None if path.first() == Some(&"wopi") => crate::office::wopi(k, &req, &path).await,
            None => crate::sharing::public(k, &req, &path).await,
            Some(ctx) => app(k, ctx, &req, &path).await,
        }
    }
}

/// The largest file a request may carry (upload, new version, editor save): the operator's
/// `FERRUM_DRIVE_MAX_FILE_MB`, 32 MB unless set, at most 1 GiB. Replicas hold a file in memory
/// while it is stored, so their memory bounds it.
pub fn max_file_bytes() -> usize {
    file_limit(std::env::var("FERRUM_DRIVE_MAX_FILE_MB").ok().as_deref())
}

fn file_limit(mb: Option<&str>) -> usize {
    mb.and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(32).clamp(1, 1024) << 20
}

/// The key an upload is stored under (`Idempotency-Key`, namespaced), and what it carried.
fn upload_key(key: &str, folder: Uuid, name: &str, body: &[u8]) -> Result<(String, String)> {
    let ok = (8..=120).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b));
    if !ok {
        return Err(Error::invalid("Idempotency-Key must be 8 to 120 letters, digits or -_.:"));
    }
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(format!("{folder}\0{name}\0").as_bytes());
    h.update(body);
    Ok((format!("drive.upload:{key}"), hex::encode(h.finalize())))
}

/// The file an earlier upload with this key made (it finished), if any.
async fn made_before(k: &Kernel, ctx: &Ctx, key: &str, hash: &str) -> Result<Option<Value>> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let row: Option<(String, Option<Value>)> = sqlx::query_as("select request_hash, response from idempotency_key where tenant_id = $1 and key = $2")
        .bind(ctx.tenant)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    match row {
        Some((stored, _)) if stored != *hash => Err(Error::invalid("this Idempotency-Key was used for another upload")),
        Some((_, made)) => Ok(made),
        None => Ok(None),
    }
}

/// Takes an upload's key in `tx`; when another request took it (and finished, since its
/// transaction held the row until then), the file that one made.
async fn take_key(tx: &mut ferrum_kernel::Tx, ctx: &Ctx, key: &str, hash: &str) -> Result<Option<Value>> {
    let fresh = sqlx::query("insert into idempotency_key (tenant_id, key, request_hash) values ($1, $2, $3) on conflict do nothing")
        .bind(ctx.tenant)
        .bind(key)
        .bind(hash)
        .execute(&mut **tx)
        .await?
        .rows_affected()
        == 1;
    if fresh {
        return Ok(None);
    }
    let (stored, made): (String, Option<Value>) = sqlx::query_as("select request_hash, response from idempotency_key where tenant_id = $1 and key = $2")
        .bind(ctx.tenant)
        .bind(key)
        .fetch_one(&mut **tx)
        .await?;
    if stored != *hash {
        return Err(Error::invalid("this Idempotency-Key was used for another upload"));
    }
    Ok(Some(made.unwrap_or(Value::Null)))
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
        ("POST", ["editor", file]) if p.str("kind") == Some("browser") => {
            crate::office::launch_browser(k, ctx, id(file)?, p.str("action") != Some("view"), p.flag("take_over"), p.str("session")).await?
        }
        ("POST", ["editor", file]) => crate::office::launch(k, ctx, id(file)?, p.str("action") != Some("view")).await?,
        ("GET", ["editors"]) => crate::office::available(),
        ("POST", ["presence", file]) => crate::collab::heartbeat(k, ctx, id(file)?, p.str("mode").unwrap_or("view")).await?,
        ("GET", ["presence"]) => {
            let ids = p.str("files").unwrap_or_default().split(',').filter(|s| !s.is_empty()).map(id).collect::<Result<Vec<_>>>()?;
            crate::collab::present(k, ctx, &ids).await?
        }
        ("POST", ["editor", file, "lock"]) => crate::office::browser_lock(k, ctx, id(file)?, p.req("lock")?, p.req("op")?).await?,
        // A blank document, spreadsheet or presentation (the editor fills in an empty file); `fdoc`
        // is a document edited live (`docs`), empty until someone types.
        ("POST", [verb @ ("upload" | "new")]) => {
            let space = tree::ensure_space(k, ctx).await?;
            let folder = p.uuid("folder")?.unwrap_or(space.root);
            let (name, on) = if *verb == "new" {
                let kind = p.req("kind")?;
                if !["fdoc", "docx", "xlsx", "pptx", "odt", "ods", "odp"].contains(&kind) {
                    return Err(Error::invalid(format!("kind must be fdoc, docx, xlsx, pptx, odt, ods or odp, not {kind}")));
                }
                (format!("{}.{kind}", p.str("name").filter(|n| !n.trim().is_empty()).unwrap_or("Untitled")), OnConflict::KeepBoth)
            } else {
                (p.req("name")?.to_string(), OnConflict::parse(p.str("on_conflict"))?)
            };
            let body: &[u8] = if *verb == "new" { &[] } else { &req.body };
            let c = Content::new(&name, body);
            // An upload sent again (the page went away before it heard back, and the next page
            // sent the file once more) gets the file the first one made.
            let key = match req.headers.get("idempotency-key").and_then(Value::as_str) {
                Some(key) if *verb == "upload" => Some(upload_key(key, folder, &name, body)?),
                _ => None,
            };
            if let Some((key, hash)) = &key
                && let Some(made) = made_before(k, ctx, key, hash).await?
            {
                return Ok(SiteResponse::json(200, &made));
            }
            let mut tx = k.db.tenant_tx(ctx.tenant).await?;
            let g = Grants::load(&mut tx, ctx).await?;
            files::check_upload(&mut tx, ctx, &g, folder, &c, on).await?;
            tx.commit().await?;
            let object = files::store(k, ctx, &c).await?;
            let res = with_retry(|| async {
                let mut tx = k.db.tenant_tx(ctx.tenant).await?;
                // The key is taken in the transaction that makes the file: a request that never
                // finishes leaves nothing behind, and one sent meanwhile waits here for the first.
                if let Some((key, hash)) = &key
                    && let Some(made) = take_key(&mut tx, ctx, key, hash).await?
                {
                    return Ok((made, false));
                }
                let g = Grants::load(&mut tx, ctx).await?;
                let out = files::commit_upload(k, ctx, &mut tx, &g, folder, &c, object, on, p.str("comment")).await?;
                if let Some((key, _)) = &key {
                    sqlx::query("update idempotency_key set status_code = 201, response = $3 where tenant_id = $1 and key = $2")
                        .bind(ctx.tenant)
                        .bind(key)
                        .bind(&out)
                        .execute(&mut *tx)
                        .await?;
                }
                tx.commit().await?;
                Ok((out, true))
            })
            .await;
            match res {
                Ok((out, true)) => return Ok(SiteResponse::json(201, &out)),
                Ok((made, false)) => {
                    files::discard(k, ctx, object).await;
                    return Ok(SiteResponse::json(200, &made));
                }
                Err(e) => {
                    files::discard(k, ctx, object).await;
                    return Err(e);
                }
            }
        }
        ("POST", ["files", file, "versions"]) => {
            let file = id(file)?;
            let check_in = p.flag("check_in");
            // A browser editor's save: the session's lock and the version it opened.
            let expect = files::Expect { lock: p.str("lock"), base: p.int("base")? };
            let mut tx = k.db.tenant_tx(ctx.tenant).await?;
            let g = Grants::load(&mut tx, ctx).await?;
            let f = tree::open_kind(&mut tx, ctx, &g, tree::Kind::File, file, crate::acl::Level::Edit, false).await?;
            let c = Content::new(&f.name, &req.body);
            files::check_version(&mut tx, ctx, &g, file, &c, check_in, expect).await?;
            tx.commit().await?;
            let object = files::store(k, ctx, &c).await?;
            let res = with_retry(|| async {
                let mut tx = k.db.tenant_tx(ctx.tenant).await?;
                let g = Grants::load(&mut tx, ctx).await?;
                let out = files::commit_version(k, ctx, &mut tx, &g, file, &c, object, p.str("comment"), check_in, expect).await?;
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
        // Images in a live document: the bytes go up as the body; they come back by their id.
        ("POST", ["files", file, "images"]) => return Ok(SiteResponse::json(201, &crate::images::upload(k, ctx, id(file)?, &req.body).await?)),
        ("GET", ["files", file, "images", image]) => return crate::images::serve(k, ctx, id(file)?, id(image)?).await,
        _ => return Err(Error::NotFound("endpoint".into())),
    };
    Ok(SiteResponse::json(200, &out))
}

/// `GET /files/{id}/content?version=&inline=1`: images and PDFs may be shown inline; everything
/// else downloads, and types a browser could run arrive as opaque bytes. A live document serves
/// its current content (or a version's) as `format=html`, `pdf`, `docx` or `txt`, its images
/// inside; without a format, its state for Ferrum.
async fn download(k: &Kernel, ctx: &Ctx, file: Uuid, p: &Params<'_>) -> Result<SiteResponse> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let g = Grants::load(&mut tx, ctx).await?;
    let d = files::prepare_download(&mut tx, ctx, &g, file, p.int("version")?).await?;
    let live = crate::docs::is_live(&d.file);
    let current = if live && p.int("version")?.is_none() { Some(crate::docs::current(k, ctx, &mut tx, &d.file).await?) } else { None };
    tx.commit().await?;
    let data = match current {
        Some(state) => state,
        None => files::read(k, ctx, d.object).await?,
    };
    if live && let Some(format) = p.str("format") {
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        files::logged(&mut tx, ctx, &d).await?;
        let g = Grants::load(&mut tx, ctx).await?;
        tx.commit().await?;
        let images = if format == "txt" { HashMap::new() } else { crate::images::for_export(k, ctx, Some(&g), d.file.id, &data).await? };
        return export(k, &d.file.name, &data, format, p.flag("inline"), &images).await;
    }
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

/// A live document as a page (`html`), a PDF (`pdf`), a Word file (`docx`) or its words
/// (`txt`), carrying the `images` it shows. Pages run nothing.
pub async fn export(k: &Kernel, name: &str, state: &[u8], format: &str, inline: bool, images: &HashMap<String, crate::images::Image>) -> Result<SiteResponse> {
    use ferrum_kernel::coedit;
    let doc = coedit::decode(state);
    let stem = crate::content::stem(name, false);
    // Pages and PDFs carry images as data: addresses, so nothing is fetched to show them.
    let inline_src = |id: &str| images.get(id).map(|i| format!("data:{};base64,{}", i.content_type, STANDARD.encode(&i.bytes)));
    let (body, ctype, ext) = match format {
        "html" => (coedit::html_page_with(stem, &doc, &inline_src).into_bytes(), "text/html; charset=utf-8", "html"),
        "pdf" => (k.html_to_pdf(&coedit::html_page_with(stem, &doc, &inline_src)).await?, "application/pdf", "pdf"),
        "docx" => {
            let picture = |id: &str| {
                images.get(id).map(|i| coedit::ImageData { bytes: i.bytes.clone(), content_type: i.content_type.clone(), width: i.width, height: i.height })
            };
            (coedit::docx(&doc, stem, &picture)?, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx")
        }
        "txt" => (coedit::plain_text(&doc).into_bytes(), "text/plain; charset=utf-8", "txt"),
        other => return Err(Error::field("format", format!("must be html, pdf, docx or txt, not {other}"))),
    };
    let headers = vec![
        ("content-disposition".to_string(), crate::content::disposition(inline, &format!("{stem}.{ext}"))),
        ("x-content-type-options".into(), "nosniff".into()),
        ("content-security-policy".into(), "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox".into()),
        ("cache-control".into(), "private, no-store".into()),
    ];
    Ok(SiteResponse { status: 200, content_type: ctype.into(), headers, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_file_routes_take_large_bodies() {
        assert_eq!(
            (file_limit(None), file_limit(Some(" 200 ")), file_limit(Some("0")), file_limit(Some("5000")), file_limit(Some("x"))),
            (32 << 20, 200 << 20, 1 << 20, 1 << 30, 32 << 20)
        );
        let file = max_file_bytes();
        for (method, path) in [("POST", "upload"), ("POST", "/files/abc/versions"), ("POST", "wopi/files/abc/contents")] {
            assert_eq!(DriveSite.max_body_for(method, path), file, "{method} {path}");
        }
        for (method, path) in [("POST", "list_folder"), ("GET", "wopi/files/abc/contents"), ("POST", "files/abc"), ("POST", "upload/x")] {
            assert_eq!(DriveSite.max_body_for(method, path), 1 << 20, "{method} {path}");
        }
    }
}

//! Images in documents edited live (Ferrum's collaboration.md, C3). A document names an image by
//! an id (the editor's `image` node); the document keeps the image's bytes itself
//! (`drive_doc_image`, 006_doc_images.sql): platform files attached to its Drive File, so whoever
//! may view the document may view its images, they go when it is deleted for good, and its space
//! pays for them.
//!
//! A copy of a document gets copies of its images under the same ids. An image pasted from
//! another document shows to those who may view that one until the next save, which gives the
//! document its own copy (when the editor saving it may view the image).
//!
//! Files that travel (downloads, PDFs, Word files, public links' pages) carry their images inside.

use crate::acl::{Grants, Level};
use crate::files::{self, Content};
use crate::tree::{self, Item, Kind};
use ferrum_kernel::{Ctx, Error, Kernel, Result, SiteResponse, Tx, coedit, with_retry};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use uuid::Uuid;

/// The largest image a document takes.
pub const MAX_IMAGE: usize = 10 << 20;
/// The widest or tallest, in pixels.
const MAX_SIDE: u32 = 20_000;
/// Most image bytes a file that travels carries; past it, images are their descriptions.
const MAX_EXPORT: usize = 64 << 20;

/// An image's bytes as a document shows them.
pub struct Image {
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub width: u32,
    pub height: u32,
}

/// The kind of image, from its bytes (never its name): the four every browser and Word show.
pub fn image_type(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if b.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

/// Width and height of a PNG, GIF, JPEG or WebP image, from its header.
pub fn dimensions(b: &[u8]) -> Option<(u32, u32)> {
    let be16 = |i: usize| b.get(i..i + 2).map(|s| u32::from(u16::from_be_bytes([s[0], s[1]])));
    let le16 = |i: usize| b.get(i..i + 2).map(|s| u32::from(u16::from_le_bytes([s[0], s[1]])));
    let be32 = |i: usize| b.get(i..i + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]));
    let le24 = |i: usize| b.get(i..i + 3).map(|s| u32::from_le_bytes([s[0], s[1], s[2], 0]));
    match image_type(b)? {
        "image/png" if b.get(12..16) == Some(b"IHDR") => Some((be32(16)?, be32(20)?)),
        "image/gif" => Some((le16(6)?, le16(8)?)),
        "image/jpeg" => {
            // The first start-of-frame segment says the size.
            let mut i = 2;
            while i + 9 < b.len() {
                if b[i] != 0xFF {
                    i += 1;
                    continue;
                }
                let marker = b[i + 1];
                if marker == 0xFF || marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
                    i += if marker == 0xFF { 1 } else { 2 };
                    continue;
                }
                if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
                    return Some((be16(i + 7)?, be16(i + 5)?));
                }
                i += 2 + be16(i + 2)? as usize;
            }
            None
        }
        "image/webp" => match b.get(12..16)? {
            b"VP8 " => Some((le16(26)? & 0x3FFF, le16(28)? & 0x3FFF)),
            b"VP8L" => {
                let v = u32::from_le_bytes(b.get(21..25)?.try_into().ok()?);
                Some(((v & 0x3FFF) + 1, ((v >> 14) & 0x3FFF) + 1))
            }
            b"VP8X" => Some((le24(24)? + 1, le24(27)? + 1)),
            _ => None,
        },
        _ => None,
    }
}

fn live(file: &Item) -> Result<()> {
    if crate::docs::is_live(file) {
        return Ok(());
    }
    Err(Error::invalid(format!("'{}' is not a document edited live: images belong in documents", file.name)))
}

/// `POST /files/{file}/images` (the image's bytes; Edit): an image for a live document. Returns
/// its `id` (what the document names it by), `width`, `height` and `content_type`.
pub async fn upload(k: &Kernel, ctx: &Ctx, file: Uuid, data: &[u8]) -> Result<Value> {
    let ctype = image_type(data).ok_or_else(|| Error::field("file", "images are PNG, JPEG, GIF or WebP"))?;
    if data.len() > MAX_IMAGE {
        return Err(Error::field("file", format!("images are limited to {} MB", MAX_IMAGE >> 20)));
    }
    let (width, height) = dimensions(data)
        .filter(|(w, h)| (1..=MAX_SIDE).contains(w) && (1..=MAX_SIDE).contains(h))
        .ok_or_else(|| Error::field("file", "this image's size cannot be read, or it is wider or taller than 20,000 pixels"))?;
    let size = data.len() as i64;
    // Access and room first: nothing is stored for a refused image.
    {
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        let g = Grants::load(&mut tx, ctx).await?;
        let doc = tree::open_kind(&mut tx, ctx, &g, Kind::File, file, Level::Edit, false).await?;
        live(&doc)?;
        let payer = tree::payer(&mut tx, ctx.tenant, doc.top()).await?;
        tree::room(&mut tx, ctx.tenant, payer, size).await?;
        tx.commit().await?;
    }
    let ext = ctype.trim_start_matches("image/");
    let c = Content::new(&format!("image.{ext}"), data);
    let object = files::put_object(k, ctx, &c).await?;
    let id = Uuid::new_v4();
    let res = with_retry(|| async {
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        let g = Grants::load(&mut tx, ctx).await?;
        let pre = tree::open_kind(&mut tx, ctx, &g, Kind::File, file, Level::Edit, false).await?;
        tree::lock_trees(&mut tx, ctx.tenant, &[pre.top()], &[]).await?;
        let doc = tree::open_kind(&mut tx, ctx, &g, Kind::File, file, Level::Edit, true).await?;
        live(&doc)?;
        let payer = tree::payer(&mut tx, ctx.tenant, doc.top()).await?;
        tree::charge(&mut tx, ctx.tenant, payer, size).await?;
        files::attach(&mut tx, ctx.tenant, object, doc.id).await?;
        insert(&mut tx, ctx.tenant, doc.id, id, object, ctype, size, width, height, Some(ctx.user)).await?;
        tx.commit().await?;
        Ok(())
    })
    .await;
    if let Err(e) = res {
        files::discard(k, ctx, object).await;
        return Err(e);
    }
    Ok(json!({"id": id, "width": width, "height": height, "content_type": ctype, "size": size}))
}

#[allow(clippy::too_many_arguments)]
async fn insert(tx: &mut Tx, tenant: Uuid, file: Uuid, id: Uuid, object: Uuid, ctype: &str, size: i64, w: u32, h: u32, by: Option<Uuid>) -> Result<()> {
    sqlx::query(
        "insert into drive_doc_image (tenant_id, file, id, object, content_type, size, width, height, created_by) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing",
    )
    .bind(tenant)
    .bind(file)
    .bind(id)
    .bind(object)
    .bind(ctype)
    .bind(size)
    .bind(w as i32)
    .bind(h as i32)
    .bind(by)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Where an image shown in `file` is kept: its own copy, else one in a document `g` may view (an
/// image pasted from there, until a save copies it). `(object, content type, size, width, height)`.
async fn find(tx: &mut Tx, ctx: &Ctx, g: Option<&Grants>, file: Uuid, image: Uuid) -> Result<Option<(Uuid, String, i64, i32, i32)>> {
    let rows: Vec<(Uuid, Uuid, String, i64, i32, i32)> = sqlx::query_as(
        "select file, object, content_type, size, width, height from drive_doc_image \
         where tenant_id = $1 and id = $2 order by (file = $3) desc, created_at limit 20",
    )
    .bind(ctx.tenant)
    .bind(image)
    .bind(file)
    .fetch_all(&mut **tx)
    .await?;
    for (from, object, ctype, size, w, h) in rows {
        if from == file {
            return Ok(Some((object, ctype, size, w, h)));
        }
        let Some(g) = g else { break };
        match tree::open_kind(tx, ctx, g, Kind::File, from, Level::View, false).await {
            Ok(_) => return Ok(Some((object, ctype, size, w, h))),
            Err(Error::NotFound(_) | Error::Forbidden(_)) => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(None)
}

/// `GET /files/{file}/images/{image}` (View): an image a live document shows.
pub async fn serve(k: &Kernel, ctx: &Ctx, file: Uuid, image: Uuid) -> Result<SiteResponse> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let g = Grants::load(&mut tx, ctx).await?;
    let doc = tree::open_kind(&mut tx, ctx, &g, Kind::File, file, Level::View, false).await?;
    live(&doc)?;
    let found = find(&mut tx, ctx, Some(&g), doc.id, image).await?;
    tx.commit().await?;
    let (object, ctype, ..) = found.ok_or_else(|| Error::NotFound("image".into()))?;
    let body = files::read(k, ctx, object).await?;
    let headers = vec![
        ("content-disposition".to_string(), format!("inline; filename=\"image.{}\"", ctype.trim_start_matches("image/"))),
        ("x-content-type-options".into(), "nosniff".into()),
        ("content-security-policy".into(), "default-src 'none'; sandbox".into()),
        // An image's bytes never change under its id.
        ("cache-control".into(), "private, max-age=31536000, immutable".into()),
    ];
    Ok(SiteResponse { status: 200, content_type: ctype, headers, body })
}

/// Gives `to` its own copy of each image `from` keeps, charged to `to`'s space (a copy of a
/// document, or a version restored as one, shows what it showed). The objects stored go in
/// `objects`, for the caller to discard if its transaction fails.
pub async fn copy(k: &Kernel, ctx: &Ctx, tx: &mut Tx, from: Uuid, to: &Item, objects: &mut Vec<Uuid>) -> Result<()> {
    let rows: Vec<(Uuid, Uuid, String, i64, i32, i32)> =
        sqlx::query_as("select id, object, content_type, size, width, height from drive_doc_image where tenant_id = $1 and file = $2")
            .bind(ctx.tenant)
            .bind(from)
            .fetch_all(&mut **tx)
            .await?;
    let mut total = 0;
    for (id, object, ctype, size, w, h) in rows {
        let bytes = files::read(k, ctx, object).await?;
        let copy = files::put_object(k, ctx, &Content::new(&format!("image.{}", ctype.trim_start_matches("image/")), &bytes)).await?;
        objects.push(copy);
        files::attach(tx, ctx.tenant, copy, to.id).await?;
        insert(tx, ctx.tenant, to.id, id, copy, &ctype, size, w as u32, h as u32, Some(ctx.user)).await?;
        total += size;
    }
    if total > 0 {
        let payer = tree::payer(tx, ctx.tenant, to.top()).await?;
        tree::charge(tx, ctx.tenant, payer, total).await?;
    }
    Ok(())
}

/// After a save: the images the document shows that it does not keep yet (pasted from another
/// document) become its own, when the editor saving it (`ctx`) may view where they are kept.
/// Images nobody saving may see stay out; the editor shows them as missing.
pub async fn adopt(k: &Kernel, ctx: &Ctx, file: Uuid, state: &[u8]) -> Result<usize> {
    let shown: Vec<Uuid> = coedit::image_ids(&coedit::decode(state)).iter().filter_map(|id| id.parse().ok()).collect();
    if shown.is_empty() || ctx.is_system {
        return Ok(0);
    }
    let mut adopted = 0;
    for image in shown {
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        let kept: bool = sqlx::query_scalar("select exists (select 1 from drive_doc_image where tenant_id = $1 and file = $2 and id = $3)")
            .bind(ctx.tenant)
            .bind(file)
            .bind(image)
            .fetch_one(&mut *tx)
            .await?;
        if kept {
            continue;
        }
        let g = Grants::load(&mut tx, ctx).await?;
        let Some((object, ctype, size, w, h)) = find(&mut tx, ctx, Some(&g), file, image).await? else { continue };
        tx.commit().await?;
        let bytes = files::read(k, ctx, object).await?;
        let copy = files::put_object(k, ctx, &Content::new(&format!("image.{}", ctype.trim_start_matches("image/")), &bytes)).await?;
        let res = with_retry(|| async {
            let mut tx = k.db.tenant_tx(ctx.tenant).await?;
            let doc = tree::load_kind(&mut tx, ctx.tenant, Kind::File, file, false).await?.ok_or_else(tree::missing)?;
            tree::lock_trees(&mut tx, ctx.tenant, &[doc.top()], &[]).await?;
            let payer = tree::payer(&mut tx, ctx.tenant, doc.top()).await?;
            tree::charge(&mut tx, ctx.tenant, payer, size).await?;
            files::attach(&mut tx, ctx.tenant, copy, doc.id).await?;
            insert(&mut tx, ctx.tenant, doc.id, image, copy, &ctype, size, w as u32, h as u32, Some(ctx.user)).await?;
            tx.commit().await?;
            Ok(())
        })
        .await;
        match res {
            Ok(()) => adopted += 1,
            Err(e) => {
                files::discard(k, ctx, copy).await;
                tracing::warn!(%file, %image, "drive: keeping a pasted image failed: {e}");
            }
        }
    }
    Ok(adopted)
}

/// The images a document shows, for a file that travels: its own copies, and (with `g`, someone
/// who may view other documents) images pasted from those. Past [`MAX_EXPORT`] bytes, the rest
/// are left to their descriptions.
pub async fn for_export(k: &Kernel, ctx: &Ctx, g: Option<&Grants>, file: Uuid, state: &[u8]) -> Result<HashMap<String, Image>> {
    let shown: BTreeSet<String> = coedit::image_ids(&coedit::decode(state));
    let mut out = HashMap::new();
    if shown.is_empty() {
        return Ok(out);
    }
    let mut found = Vec::new();
    {
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        for id in &shown {
            let Ok(image) = id.parse::<Uuid>() else { continue };
            if let Some(f) = find(&mut tx, ctx, g, file, image).await? {
                found.push((id.clone(), f));
            }
        }
        tx.commit().await?;
    }
    let mut total = 0usize;
    for (id, (object, ctype, size, w, h)) in found {
        total += size as usize;
        if total > MAX_EXPORT {
            break;
        }
        let bytes = files::read(k, ctx, object).await?;
        out.insert(id, Image { bytes, content_type: ctype, width: w as u32, height: h as u32 });
    }
    Ok(out)
}

/// The bytes of a document's images in a subtree (or of one file), for moving usage between payers.
pub async fn bytes_in(tx: &mut Tx, tenant: Uuid, item: &Item) -> Result<i64> {
    let bytes: Option<i64> = match item.kind {
        Kind::File => {
            sqlx::query_scalar("select sum(size)::bigint from drive_doc_image where tenant_id = $1 and file = $2")
                .bind(tenant)
                .bind(item.id)
                .fetch_one(&mut **tx)
                .await?
        }
        Kind::Folder => {
            sqlx::query_scalar(
                "select sum(i.size)::bigint from drive_doc_image i join e_drive_file f on f.tenant_id = i.tenant_id and f.id = i.file \
                 where i.tenant_id = $1 and f.ancestors ? $2",
            )
            .bind(tenant)
            .bind(item.id.to_string())
            .fetch_one(&mut **tx)
            .await?
        }
    };
    Ok(bytes.unwrap_or(0))
}

/// Forgets the images of documents deleted for good (their bytes go with the files'); returns
/// their size, which the caller refunds.
pub async fn forget(tx: &mut Tx, tenant: Uuid, files: &[Uuid]) -> Result<i64> {
    let bytes: Option<i64> = sqlx::query_scalar(
        "with gone as (delete from drive_doc_image where tenant_id = $1 and file = any($2) returning size) select sum(size)::bigint from gone",
    )
    .bind(tenant)
    .bind(files)
    .fetch_one(&mut **tx)
    .await?;
    Ok(bytes.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_sizes_from_the_bytes() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        assert_eq!((image_type(&png), dimensions(&png)), (Some("image/png"), Some((640, 480))));
        let gif = b"GIF89a\x20\x03\x58\x02rest".to_vec();
        assert_eq!(dimensions(&gif), Some((800, 600)));
        // JPEG: an APP0 segment, then a baseline frame of 1024×768.
        let mut jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00".to_vec();
        jpeg.extend_from_slice(b"\xff\xc0\x00\x11\x08\x03\x00\x04\x00\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01");
        assert_eq!((image_type(&jpeg), dimensions(&jpeg)), (Some("image/jpeg"), Some((1024, 768))));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\x10\0\0\0".to_vec();
        webp.extend_from_slice(&[0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]);
        assert_eq!((image_type(&webp), dimensions(&webp)), (Some("image/webp"), Some((640, 480))));
        assert_eq!(image_type(b"<svg xmlns='http://www.w3.org/2000/svg'/>"), None, "no SVG: it can carry scripts");
        assert_eq!(image_type(b"%PDF-1.7"), None);
        assert_eq!(dimensions(b"\xff\xd8\xff\xe0"), None, "a cut-off JPEG has no size");
    }
}

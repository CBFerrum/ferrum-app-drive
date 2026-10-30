//! Sharing with people and roles, and public links.
//!
//! A share gives one person (by email) or everyone holding a role a level on a file, or on a
//! folder and everything in it, optionally until a moment; access is evaluated live, so removing
//! a share, an expiry passing or a role being taken away applies to the next request.
//!
//! A public link is a 256-bit random token (only its SHA-256 is stored) that lets anyone open a
//! file or browse a folder: View links list and preview images and PDFs, Download links also
//! download. Links stop working when revoked, expired, out of downloads (counted atomically) or
//! when the item is trashed or deleted, and every such case answers exactly like an unknown
//! token. A password (Argon2id) is exchanged once for a one-hour grant signed with a per-tenant
//! key kept outside every entity; ten wrong passwords lock the link for 15 minutes.
//!
//! Sharing with someone outside the workspace (a guest) makes a Download link for them alone,
//! under the same rules, and mails it to them. Sharing with them again replaces it.

use crate::acl::{Grants, Level};
use crate::content;
use crate::day_start;
use crate::files::{self, actor};
use crate::ops::{Out, Params};
use crate::tree::{self, FILE_COLS, FOLDER_COLS, Item, Kind};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use ferrum_domain::util::elevated;
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, SiteRequest, SiteResponse, Tx, notify};
use hmac::{Hmac, Mac};
use rand::Rng;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::QueryBuilder;
use uuid::Uuid;

/// An expiry: an RFC 3339 instant, or a date meaning the end of that day in the workspace's time
/// zone. It must lie in the future.
fn expiry(ctx: &Ctx, raw: Option<&str>, field: &str) -> Result<Option<DateTime<Utc>>> {
    let Some(raw) = raw else { return Ok(None) };
    let at = match ferrum_kernel::value::parse_datetime(raw) {
        Ok(t) => t,
        Err(_) => {
            let day = NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| Error::field(field, "use a date (YYYY-MM-DD) or an RFC 3339 date-time"))?;
            day_start(&ctx.schema.timezone, day.succ_opt().ok_or_else(|| Error::field(field, "is out of range"))?)
        }
    };
    if at <= Utc::now() {
        return Err(Error::field(field, "must be in the future"));
    }
    Ok(Some(at))
}

fn item_columns(item: &Item) -> (Option<Uuid>, Option<Uuid>) {
    match item.kind {
        Kind::File => (Some(item.id), None),
        Kind::Folder => (None, Some(item.id)),
    }
}

/// `share`: grants a person (`email`) or a role (`role`) `permission` on an item until
/// `expires_at` (optional). Sharing again with the same person or role replaces the grant.
pub async fn share(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let item = tree::open(tx, ctx, g, p.req_uuid("item")?, Level::Manage, true).await?;
    let (email, role) = match (p.str("email").map(str::to_lowercase), p.str("role")) {
        (Some(e), None) => (Some(e), None),
        (None, Some(r)) => (None, Some(r.to_string())),
        _ => return Err(Error::field("email", "share with either a person (email) or a role")),
    };
    let level =
        Level::from_permission(p.str("permission").unwrap_or("View")).ok_or_else(|| Error::field("permission", "must be View, Comment, Edit or Manage"))?;
    let expires = expiry(ctx, p.str("expires_at"), "expires_at")?;
    let mut recipient = None;
    if let Some(e) = &email {
        if Some(e) == actor(ctx).as_ref() {
            return Err(Error::field("email", "you cannot share with yourself"));
        }
        match tree::user_by_email(tx, ctx.tenant, e).await? {
            Some(user) => recipient = Some(user.0),
            // A deactivated colleague is no guest: a link would let them back in.
            None if sqlx::query_scalar("select exists (select 1 from app_user where tenant_id = $1 and email = $2)")
                .bind(ctx.tenant)
                .bind(e)
                .fetch_one(&mut **tx)
                .await? =>
            {
                return Err(Error::field("email", format!("{e} is not an active user of this workspace")));
            }
            None => return share_with_guest(k, ctx, tx, &item, e, level, expires).await,
        }
    }
    if let Some(r) = &role {
        let exists: bool =
            sqlx::query_scalar("select exists (select 1 from role where tenant_id = $1 and name = $2)").bind(ctx.tenant).bind(r).fetch_one(&mut **tx).await?;
        if !exists {
            return Err(Error::field("role", format!("there is no role named {r}")));
        }
    }
    let (file, folder) = item_columns(&item);
    let existing: Option<Uuid> =
        sqlx::query_scalar("select id from e_drive_share where tenant_id = $1 and (file = $2 or folder = $2) and (email = $3 or role = $4) for update")
            .bind(ctx.tenant)
            .bind(item.id)
            .bind(&email)
            .bind(&role)
            .fetch_optional(&mut **tx)
            .await?;
    let mut doc = Doc::new();
    for (key, v) in [("permission", json!(level.name())), ("level", json!(level.as_int())), ("expires_at", json!(expires)), ("shared_by", json!(actor(ctx)))] {
        doc.insert(key.into(), v);
    }
    let id = match existing {
        Some(id) => {
            k.update_tx(&elevated(ctx), tx, "DriveShare", id, doc, None).await?;
            id
        }
        None => {
            let id = Uuid::now_v7();
            for (key, v) in [("id", json!(id)), ("file", json!(file)), ("folder", json!(folder)), ("email", json!(email)), ("role", json!(role))] {
                doc.insert(key.into(), v);
            }
            k.insert_tx(&elevated(ctx), tx, "DriveShare", doc).await?;
            id
        }
    };
    if let (Some(user), Some(e)) = (recipient, &email) {
        let by = if ctx.full_name.trim().is_empty() { "Someone".to_string() } else { ctx.full_name.clone() };
        let title = format!("{by} shared \"{}\" with you", item.name);
        notify::send(tx, ctx.tenant, user, &title, Some(&format!("{} access", level.name())), Some(item.kind.entity()), Some(item.id)).await?;
        let what = if item.kind == Kind::File { "a file" } else { "a folder" };
        mail(k, ctx, tx, e, &format!("{by} shared {what} with you"), &format!("{by} gave you {} access to {what} in Drive", level.name())).await?;
    }
    tree::log(tx, ctx, &item, "Share", json!({"email": email, "role": role, "permission": level.name(), "expires_at": expires})).await?;
    Ok(json!({"id": id, "item": item.id, "email": email, "role": role, "permission": level.name(), "expires_at": expires}))
}

/// Sharing with someone outside the workspace: a link for them alone (they view and download),
/// under the workspace's rules for public links, mailed to them.
async fn share_with_guest(k: &Kernel, ctx: &Ctx, tx: &mut Tx, item: &Item, email: &str, level: Level, expires: Option<DateTime<Utc>>) -> Out {
    if !email.contains('@') || email.chars().any(char::is_whitespace) || email.len() > 254 {
        return Err(Error::field("email", "is not an email address"));
    }
    if level != Level::View {
        return Err(Error::field("permission", "someone outside the workspace can only be a Viewer"));
    }
    let s = tree::settings(tx, ctx.tenant).await?;
    if !s.allow_public_links {
        return Err(Error::Forbidden("sharing with people outside the workspace uses public links, which are turned off for this workspace".into()));
    }
    if s.link_password_required {
        return Err(Error::Forbidden("links in this workspace need a password: make a public link with a password, and send both".into()));
    }
    let expires = match (expires, s.max_link_days) {
        (None, days) if days > 0 => Some(Utc::now() + Duration::days(days)),
        (Some(t), days) if days > 0 && t > Utc::now() + Duration::days(days) => {
            return Err(Error::field("expires_at", format!("links to people outside the workspace must end within {days} days")));
        }
        (t, _) => t,
    };
    let page = k
        .settings
        .public_url
        .clone()
        .ok_or_else(|| Error::Unavailable("the server's public address (PUBLIC_URL) is not set, so links cannot be sent".into()))?;
    let (file, folder) = item_columns(item);
    sqlx::query(
        "update e_drive_link set revoked = true, revoked_at = now(), revoked_by = $4 \
         where tenant_id = $1 and email = $2 and (file = $3 or folder = $3) and not revoked",
    )
    .bind(ctx.tenant)
    .bind(email)
    .bind(item.id)
    .bind(actor(ctx))
    .execute(&mut **tx)
    .await?;
    let (token, hash) = new_token();
    let id = Uuid::now_v7();
    insert_link(tx, ctx, id, file, folder, "Download", &hash, None, expires, None, Some(email)).await?;
    tree::log(tx, ctx, item, "Shared With Guest", json!({"link": id, "email": email, "expires_at": expires})).await?;
    let page = format!("{page}/app/s/{}/{token}", tenant_slug(tx, ctx.tenant).await?);
    let by = if ctx.full_name.trim().is_empty() { ctx.email.clone() } else { ctx.full_name.clone() };
    let until = expires.map(|t| format!(" The link works until {}.", t.format("%-d %B %Y"))).unwrap_or_default();
    let mailed = guest_mail(k, ctx, tx, email, &format!("{by} shared \"{}\" with you", item.name), &page, &until).await?;
    Ok(json!({"id": id, "item": item.id, "email": email, "guest": true, "permission": "View", "expires_at": expires, "mailed": mailed,
              "page": if mailed { None } else { Some(page) }}))
}

/// Mails a guest their link, where mail can be sent (Mail, Chat and Calendar installed).
async fn guest_mail(k: &Kernel, ctx: &Ctx, tx: &mut Tx, to: &str, subject: &str, page: &str, until: &str) -> Result<bool> {
    if !ctx.schema.packages.iter().any(|p| p == "comms") || ctx.schema.entity("Communication").is_none() {
        return Ok(false);
    }
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    let mut doc = Doc::new();
    for (key, v) in [
        ("channel", json!("Email")),
        ("direction", json!("Sent")),
        ("recipients", json!(to)),
        ("subject", json!(subject)),
        ("content", json!(format!("<p>{}.</p><p><a href=\"{}\">Open it</a>.{}</p>", escape(subject), escape(page), escape(until)))),
        ("text_content", json!(format!("{subject}: {page}{until}"))),
    ] {
        doc.insert(key.into(), v);
    }
    k.insert_tx(&ferrum_domain::util::sys(ctx), tx, "Communication", doc).await?;
    Ok(true)
}

/// A link's record. Written directly, not through the document pipeline: the record carries
/// hashes that must not travel in change events.
#[allow(clippy::too_many_arguments)]
async fn insert_link(
    tx: &mut Tx,
    ctx: &Ctx,
    id: Uuid,
    file: Option<Uuid>,
    folder: Option<Uuid>,
    access: &str,
    token_hash: &str,
    password_hash: Option<&str>,
    expires: Option<DateTime<Utc>>,
    max_downloads: Option<i64>,
    email: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "insert into e_drive_link (tenant_id, id, file, folder, access, token_hash, password_hash, has_password, expires_at, max_downloads, \
         download_count, revoked, shared_by, failed_attempts, email, created_by, updated_by) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, false, $11, 0, $12, $13, $13)",
    )
    .bind(ctx.tenant)
    .bind(id)
    .bind(file)
    .bind(folder)
    .bind(access)
    .bind(token_hash)
    .bind(password_hash)
    .bind(password_hash.is_some())
    .bind(expires)
    .bind(max_downloads)
    .bind(actor(ctx))
    .bind(email)
    .bind((!ctx.user.is_nil()).then_some(ctx.user))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// `unshare`: removes a share of an item (by `share` id, `email` or `role`). Removing your own
/// share (leaving) needs no more than seeing the item; anything else needs Manage access.
pub async fn unshare(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let item = tree::open(tx, ctx, g, p.req_uuid("item")?, Level::View, true).await?;
    let row: Option<(Uuid, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, email, role from e_drive_share where tenant_id = $1 and (file = $2 or folder = $2) \
         and (id = $3 or email = $4 or role = $5) order by (id = $3) desc limit 1",
    )
    .bind(ctx.tenant)
    .bind(item.id)
    .bind(p.uuid("share")?)
    .bind(p.str("email").map(str::to_lowercase))
    .bind(p.str("role"))
    .fetch_optional(&mut **tx)
    .await?;
    let (id, email, role) = row.ok_or_else(|| Error::NotFound("share".into()))?;
    let leaving = email.is_some() && email == actor(ctx);
    if !leaving && item.level(g) < Level::Manage {
        return Err(Error::Forbidden("removing other people's access needs Manage access".into()));
    }
    k.delete_tx(&elevated(ctx), tx, "DriveShare", id, None).await?;
    tree::log(tx, ctx, &item, "Unshare", json!({"email": email, "role": role})).await?;
    Ok(json!({"removed": id}))
}

/// `list_shares`: who has access — the space owner or the team's members (for those who can see
/// the team folder), and the unexpired shares of the item and of the enclosing folders the caller
/// can see (shares of folders the caller cannot see are not theirs to know).
pub async fn list_shares(tx: &mut Tx, ctx: &Ctx, g: &Grants, p: &Params<'_>) -> Out {
    let item = tree::open(tx, ctx, g, p.req_uuid("item")?, Level::View, false).await?;
    let a = &item.ancestors;
    let top = a.first().copied();
    let mut visible: Vec<Uuid> = (0..a.len()).filter(|&i| g.level(a[i], if i == 0 { None } else { top }, &a[..i]) >= Level::View).map(|i| a[i]).collect();
    visible.push(item.id);
    type R = (Uuid, Option<Uuid>, Option<Uuid>, Option<String>, Option<String>, String, Option<DateTime<Utc>>, Option<String>, DateTime<Utc>);
    let rows: Vec<R> = sqlx::query_as(
        "select id, file, folder, email, role, permission, expires_at, shared_by, created_at from e_drive_share \
         where tenant_id = $1 and (file = $2 or folder = any($3)) and (expires_at is null or expires_at > now()) order by created_at",
    )
    .bind(ctx.tenant)
    .bind(item.id)
    .bind(&visible)
    .fetch_all(&mut **tx)
    .await?;
    let shares: Vec<Value> = rows
        .into_iter()
        .map(|(id, file, folder, email, role, permission, expires, by, at)| {
            let on = file.or(folder);
            json!({"id": id, "email": email, "role": role, "permission": permission, "expires_at": expires, "shared_by": by, "created_at": at,
                   "inherited_from": if on == Some(item.id) { None } else { on }})
        })
        .collect();
    let team = match item.owner {
        None if g.level(item.top(), None, &[]) >= Level::View => {
            let (name,): (String,) = sqlx::query_as("select name from e_drive_folder where tenant_id = $1 and id = $2")
                .bind(ctx.tenant)
                .bind(item.top())
                .fetch_one(&mut **tx)
                .await?;
            let members: Vec<(String, String)> =
                sqlx::query_as("select member, role from e_drive_folder__members where tenant_id = $1 and parent_id = $2 order by idx")
                    .bind(ctx.tenant)
                    .bind(item.top())
                    .fetch_all(&mut **tx)
                    .await?;
            json!({"id": item.top(), "name": name, "members": members.into_iter().map(|(m, r)| json!({"member": m, "role": r})).collect::<Vec<_>>()})
        }
        _ => Value::Null,
    };
    Ok(json!({"item": item.id, "owner": item.owner, "team": team, "shares": shares}))
}

/// Emails a person through the Mail app when the workspace has it (it delivers, retries and
/// logs). The message names no file or folder — Mail's managers read every message — only who
/// shared what kind of item; the in-app notification carries the name.
pub async fn mail(k: &Kernel, ctx: &Ctx, tx: &mut Tx, to: &str, subject: &str, line: &str) -> Result<()> {
    if !ctx.schema.packages.iter().any(|p| p == "comms") || ctx.schema.entity("Communication").is_none() {
        return Ok(());
    }
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    let text = format!("{line}. Open Drive to find it.");
    let mut doc = Doc::new();
    for (key, v) in [
        ("channel", json!("Email")),
        ("direction", json!("Sent")),
        ("recipients", json!(to)),
        ("subject", json!(subject)),
        ("content", json!(format!("<p>{}.</p><p>Open Drive to find it.</p>", escape(line)))),
        ("text_content", json!(text)),
    ] {
        doc.insert(key.into(), v);
    }
    k.insert_tx(&ferrum_domain::util::sys(ctx), tx, "Communication", doc).await?;
    Ok(())
}

// ───────────────────────────── public links ─────────────────────────────

/// A new link token and the hash stored for it.
fn new_token() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = token_hash(&token);
    (token, hash)
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Shaped like a token we issue (43 URL-safe base64 characters): anything else is not looked up.
fn well_formed(token: &str) -> bool {
    token.len() == 43 && token.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

async fn tenant_slug(tx: &mut Tx, tenant: Uuid) -> Result<String> {
    Ok(sqlx::query_scalar("select slug from tenant where id = $1").bind(tenant).fetch_one(&mut **tx).await?)
}

/// `create_link` (Manage access): `access` View or Download, optional `expires_at`, `password`
/// (8+ characters) and `max_downloads`, within the workspace's link policy. The token is in the
/// answer only.
pub async fn create_link(_k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let s = tree::settings(tx, ctx.tenant).await?;
    if !s.allow_public_links {
        return Err(Error::Forbidden("public links are turned off for this workspace".into()));
    }
    let item = tree::open(tx, ctx, g, p.req_uuid("item")?, Level::Manage, false).await?;
    let access = p.str("access").unwrap_or("View");
    if !["View", "Download"].contains(&access) {
        return Err(Error::field("access", "must be View or Download"));
    }
    let expires = expiry(ctx, p.str("expires_at"), "expires_at")?;
    if s.max_link_days > 0 {
        let latest = Utc::now() + Duration::days(s.max_link_days);
        if expires.is_none_or(|t| t > latest) {
            return Err(Error::field("expires_at", format!("public links must expire within {} days", s.max_link_days)));
        }
    }
    let password = p.0.get("password").and_then(Value::as_str).filter(|pw| !pw.is_empty());
    if s.link_password_required && password.is_none() {
        return Err(Error::field("password", "public links need a password in this workspace"));
    }
    if password.is_some_and(|pw| !(8..=256).contains(&pw.chars().count())) {
        return Err(Error::field("password", "use 8 to 256 characters"));
    }
    let max_downloads = match p.int("max_downloads")? {
        Some(n) if n < 0 => return Err(Error::field("max_downloads", "must be 0 (unlimited) or more")),
        n => n.filter(|n| *n > 0),
    };
    let password_hash = match password {
        Some(pw) => Some(ferrum_kernel::auth::hash_password(pw.to_string()).await?),
        None => None,
    };
    let (token, hash) = new_token();
    let id = Uuid::now_v7();
    let (file, folder) = item_columns(&item);
    insert_link(tx, ctx, id, file, folder, access, &hash, password_hash.as_deref(), expires, max_downloads, None).await?;
    tree::log(
        tx,
        ctx,
        &item,
        "Link Created",
        json!({"link": id, "access": access, "expires_at": expires, "password": password.is_some(), "max_downloads": max_downloads}),
    )
    .await?;
    let slug = tenant_slug(tx, ctx.tenant).await?;
    Ok(
        json!({"id": id, "item": item.id, "token": token, "url": format!("/api/site/{slug}/drive/links/{token}"), "page": format!("/app/s/{slug}/{token}"), "access": access,
              "expires_at": expires, "has_password": password.is_some(), "max_downloads": max_downloads}),
    )
}

/// `revoke_link` (Manage access to its item, which may be in the trash).
pub async fn revoke_link(ctx: &Ctx, tx: &mut Tx, g: &Grants, p: &Params<'_>) -> Out {
    let id = p.req_uuid("link")?;
    let row: Option<(Option<Uuid>, Option<Uuid>, bool)> =
        sqlx::query_as("select file, folder, revoked from e_drive_link where tenant_id = $1 and id = $2 for update")
            .bind(ctx.tenant)
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    let (file, folder, revoked) = row.ok_or_else(|| Error::NotFound("link".into()))?;
    let item = match file.or(folder) {
        Some(i) => tree::load(tx, ctx.tenant, i).await?,
        None => None,
    };
    let item = item.filter(|i| i.level(g) >= Level::View).ok_or_else(|| Error::NotFound("link".into()))?;
    if item.level(g) < Level::Manage {
        return Err(Error::Forbidden("revoking a public link needs Manage access".into()));
    }
    if !revoked {
        sqlx::query("update e_drive_link set revoked = true, revoked_at = now(), revoked_by = $3, updated_at = now(), version = version + 1 where tenant_id = $1 and id = $2")
            .bind(ctx.tenant)
            .bind(id)
            .bind(actor(ctx))
            .execute(&mut **tx)
            .await?;
        tree::log(tx, ctx, &item, "Link Revoked", json!({"link": id})).await?;
    }
    Ok(json!({"link": id, "revoked": true}))
}

/// `list_links` (Manage access): every link of the item, newest first, without tokens.
pub async fn list_links(tx: &mut Tx, ctx: &Ctx, g: &Grants, p: &Params<'_>) -> Out {
    let item = tree::open(tx, ctx, g, p.req_uuid("item")?, Level::Manage, false).await?;
    type R = (Uuid, String, bool, Option<DateTime<Utc>>, Option<i64>, Option<i64>, bool, Option<String>, DateTime<Utc>, Option<DateTime<Utc>>, Option<String>);
    let rows: Vec<R> = sqlx::query_as(
        "select id, access, coalesce(has_password, false), expires_at, max_downloads, download_count, revoked, shared_by, created_at, last_accessed_at, email::text \
         from e_drive_link where tenant_id = $1 and (file = $2 or folder = $2) order by created_at desc",
    )
    .bind(ctx.tenant)
    .bind(item.id)
    .fetch_all(&mut **tx)
    .await?;
    let now = Utc::now();
    Ok(json!({"item": item.id, "links": rows.into_iter().map(|(id, access, pw, exp, max, count, revoked, by, at, last, email)| {
        let count = count.unwrap_or(0);
        let active = !revoked && exp.is_none_or(|t| t > now) && max.is_none_or(|m| m == 0 || count < m);
        json!({"id": id, "access": access, "has_password": pw, "expires_at": exp, "max_downloads": max, "download_count": count,
               "revoked": revoked, "shared_by": by, "created_at": at, "last_accessed_at": last, "active": active, "email": email})
    }).collect::<Vec<_>>()}))
}

// ───────────────────────────── guests ─────────────────────────────

#[derive(sqlx::FromRow)]
struct Link {
    id: Uuid,
    file: Option<Uuid>,
    folder: Option<Uuid>,
    access: String,
    password_hash: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    max_downloads: Option<i64>,
    download_count: Option<i64>,
    revoked: bool,
    locked_until: Option<DateTime<Utc>>,
}

/// The single answer for unknown, revoked, expired, exhausted and out-of-reach links.
fn gone() -> Error {
    Error::NotFound("link".into())
}

/// The link of a token and its item, if both are usable right now.
async fn active_link(tx: &mut Tx, tenant: Uuid, token: &str) -> Result<(Link, Item)> {
    if !well_formed(token) || !tree::settings(tx, tenant).await?.allow_public_links {
        return Err(gone());
    }
    let link: Option<Link> = sqlx::query_as(
        "select id, file, folder, access, password_hash, expires_at, max_downloads, download_count, revoked, locked_until \
         from e_drive_link where tenant_id = $1 and token_hash = $2",
    )
    .bind(tenant)
    .bind(token_hash(token))
    .fetch_optional(&mut **tx)
    .await?;
    let now = Utc::now();
    let link = link
        .filter(|l| !l.revoked && l.expires_at.is_none_or(|t| t > now) && l.max_downloads.is_none_or(|m| m == 0 || l.download_count.unwrap_or(0) < m))
        .ok_or_else(gone)?;
    let item = match link.file.or(link.folder) {
        Some(i) => tree::load(tx, tenant, i).await?,
        None => None,
    };
    let item = item.ok_or_else(gone)?;
    if tree::in_trash(tx, tenant, &item).await? {
        return Err(gone());
    }
    Ok((link, item))
}

/// The per-tenant key signing unlock grants (created on first use; never in any entity).
pub(crate) async fn tenant_key(tx: &mut Tx, tenant: Uuid) -> Result<Vec<u8>> {
    let existing: Option<Vec<u8>> = sqlx::query_scalar("select secret from drive_secret where tenant_id = $1").bind(tenant).fetch_optional(&mut **tx).await?;
    if let Some(k) = existing {
        return Ok(k);
    }
    let mut fresh = [0u8; 32];
    rand::rng().fill(&mut fresh);
    sqlx::query("insert into drive_secret (tenant_id, secret) values ($1, $2) on conflict do nothing").bind(tenant).bind(&fresh[..]).execute(&mut **tx).await?;
    Ok(sqlx::query_scalar("select secret from drive_secret where tenant_id = $1").bind(tenant).fetch_one(&mut **tx).await?)
}

/// The grant MAC binds the link, its current password (a new password voids old grants) and the expiry.
fn grant_mac(key: &[u8], link: Uuid, password_hash: &str, exp: i64) -> Result<Hmac<Sha256>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(Error::internal)?;
    mac.update(b"ferrum-drive-link-grant:");
    mac.update(link.as_bytes());
    mac.update(&exp.to_be_bytes());
    mac.update(&Sha256::digest(password_hash.as_bytes()));
    Ok(mac)
}

fn sign_grant(key: &[u8], link: Uuid, password_hash: &str, exp: i64) -> Result<String> {
    Ok(format!("{exp}.{}", URL_SAFE_NO_PAD.encode(grant_mac(key, link, password_hash, exp)?.finalize().into_bytes())))
}

/// Checks a grant in constant time.
fn grant_valid(key: &[u8], link: Uuid, password_hash: &str, grant: &str, now: i64) -> bool {
    let Some((exp, sig)) = grant.trim().split_once('.') else { return false };
    let (Ok(exp), Ok(sig)) = (exp.parse::<i64>(), URL_SAFE_NO_PAD.decode(sig)) else { return false };
    exp > now && grant_mac(key, link, password_hash, exp).is_ok_and(|m| m.verify_slice(&sig).is_ok())
}

fn header<'a>(req: &'a SiteRequest, name: &str) -> Option<&'a str> {
    req.headers.get(name).and_then(Value::as_str)
}

/// Password-protected links need a valid grant (`x-drive-grant` header or `grant` parameter).
async fn gate(tx: &mut Tx, req: &SiteRequest, link: &Link) -> Result<()> {
    let Some(hash) = &link.password_hash else { return Ok(()) };
    let grant = header(req, "x-drive-grant").or_else(|| req.query.get("grant").and_then(Value::as_str));
    let key = tenant_key(tx, req.tenant).await?;
    if grant.is_some_and(|gr| grant_valid(&key, link.id, hash, gr, Utc::now().timestamp())) {
        return Ok(());
    }
    Err(Error::Unauthorized("this link needs its password: send it to the link's /unlock address".into()))
}

/// An item inside the link's item (or the item itself), out of the trash.
async fn within(tx: &mut Tx, tenant: Uuid, shared: &Item, id: Option<Uuid>, kind: Kind) -> Result<Item> {
    let id = id.unwrap_or(shared.id);
    if id == shared.id {
        return if shared.kind == kind { Ok(shared.clone()) } else { Err(gone()) };
    }
    let item = tree::load_kind(tx, tenant, kind, id, false).await?.ok_or_else(gone)?;
    if shared.kind != Kind::Folder || !item.ancestors.contains(&shared.id) || tree::in_trash(tx, tenant, &item).await? {
        return Err(gone());
    }
    Ok(item)
}

fn guest_json(item: &Item) -> Value {
    json!({"id": item.id, "kind": item.kind.name(), "name": item.name,
           "size": if item.kind == Kind::File { Some(item.size) } else { None },
           "content_type": item.content_type, "file_type": item.file_type, "modified_at": item.modified_at})
}

fn guest_headers() -> Vec<(String, String)> {
    vec![("cache-control".into(), "no-store".into()), ("x-robots-tag".into(), "noindex, nofollow".into()), ("referrer-policy".into(), "no-referrer".into())]
}

/// Guest endpoints under `/api/site/{tenant}/drive/`.
pub async fn public(k: &Kernel, req: &SiteRequest, path: &[&str]) -> Result<SiteResponse> {
    match (req.method.as_str(), path) {
        ("GET", ["links", token]) => view(k, req, token).await,
        ("POST", ["links", token, "unlock"]) => unlock(k, req, token).await,
        ("GET", ["links", token, "content"]) => fetch(k, req, token).await,
        _ => Err(Error::NotFound("page".into())),
    }
}

fn query(req: &SiteRequest) -> Value {
    Value::Object(req.query.clone())
}

/// `GET /links/{token}`: the shared item; for folders, a page of one folder inside it (`folder`).
async fn view(k: &Kernel, req: &SiteRequest, token: &str) -> Result<SiteResponse> {
    let q = query(req);
    let q = Params(&q);
    let mut tx = k.db.tenant_tx(req.tenant).await?;
    let (link, item) = active_link(&mut tx, req.tenant, token).await?;
    gate(&mut tx, req, &link).await?;
    let left = link.max_downloads.filter(|m| *m > 0).map(|m| m - link.download_count.unwrap_or(0));
    let mut out = json!({
        "link": {"access": link.access, "expires_at": link.expires_at, "downloads_left": left, "has_password": link.password_hash.is_some()},
        "item": guest_json(&item),
    });
    if item.kind == Kind::Folder {
        let folder = within(&mut tx, req.tenant, &item, q.uuid("folder").map_err(|_| gone())?, Kind::Folder).await?;
        let limit = q.int("limit").map_err(|_| gone())?.unwrap_or(100).clamp(1, 200);
        let offset = q.int("offset").map_err(|_| gone())?.unwrap_or(0).clamp(0, 100_000);
        let mut qb = QueryBuilder::new(format!("select * from ((select {FOLDER_COLS} from e_drive_folder a where a.tenant_id = "));
        qb.push_bind(req.tenant).push(" and a.parent = ").push_bind(folder.id).push(" and not a.trashed)");
        qb.push(format!(" union all (select {FILE_COLS} from e_drive_file a where a.tenant_id = ")).push_bind(req.tenant);
        qb.push(" and a.folder = ").push_bind(folder.id).push(" and not a.trashed)) x order by (x.kind = 'file'), lower(x.name), x.id limit ");
        qb.push_bind(limit).push(" offset ").push_bind(offset);
        let items = tree::fetch(&mut tx, &mut qb).await?;
        let start = folder.ancestors.iter().position(|a| *a == item.id).unwrap_or(folder.ancestors.len());
        let mut path: Vec<Uuid> = folder.ancestors[start..].to_vec();
        path.push(folder.id);
        let names: Vec<(Uuid, String)> = sqlx::query_as("select id, name from e_drive_folder where tenant_id = $1 and id = any($2)")
            .bind(req.tenant)
            .bind(&path)
            .fetch_all(&mut *tx)
            .await?;
        out["folder"] = guest_json(&folder);
        out["breadcrumbs"] = json!(path.iter().filter_map(|id| names.iter().find(|n| n.0 == *id)).map(|n| json!({"id": n.0, "name": n.1})).collect::<Vec<_>>());
        out["items"] = json!(items.iter().map(guest_json).collect::<Vec<_>>());
    }
    sqlx::query("update e_drive_link set last_accessed_at = now() where tenant_id = $1 and id = $2").bind(req.tenant).bind(link.id).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut resp = SiteResponse::json(200, &out);
    resp.headers = guest_headers();
    Ok(resp)
}

/// `POST /links/{token}/unlock` `{password}`: a one-hour grant for a password-protected link.
async fn unlock(k: &Kernel, req: &SiteRequest, token: &str) -> Result<SiteResponse> {
    if req.body.len() > 4096 {
        return Err(Error::invalid("request too large"));
    }
    let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
    let password = body.get("password").and_then(Value::as_str).filter(|p| !p.is_empty() && p.len() <= 1024).map(str::to_string);
    let mut tx = k.db.tenant_tx(req.tenant).await?;
    let (link, _) = active_link(&mut tx, req.tenant, token).await?;
    let Some(hash) = link.password_hash.clone() else {
        tx.commit().await?;
        return Ok(SiteResponse::json(200, &json!({"grant": null, "expires_at": null})));
    };
    if link.locked_until.is_some_and(|t| t > Utc::now()) {
        return Err(Error::TooManyRequests("too many wrong passwords for this link; try again in 15 minutes".into()));
    }
    tx.commit().await?;
    let Some(password) = password else { return Err(Error::field("password", "is required")) };
    // Argon2 runs outside any transaction.
    let ok = ferrum_kernel::auth::verify_password(password, hash.clone()).await;
    let mut tx = k.db.tenant_tx(req.tenant).await?;
    if !ok {
        sqlx::query(
            "update e_drive_link set failed_attempts = coalesce(failed_attempts, 0) + 1, \
             locked_until = case when coalesce(failed_attempts, 0) + 1 >= 10 then now() + interval '15 minutes' else locked_until end \
             where tenant_id = $1 and id = $2",
        )
        .bind(req.tenant)
        .bind(link.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(Error::Unauthorized("wrong password".into()));
    }
    sqlx::query("update e_drive_link set failed_attempts = 0, locked_until = null where tenant_id = $1 and id = $2 and coalesce(failed_attempts, 0) > 0")
        .bind(req.tenant)
        .bind(link.id)
        .execute(&mut *tx)
        .await?;
    let key = tenant_key(&mut tx, req.tenant).await?;
    let exp = (Utc::now() + Duration::hours(1)).timestamp();
    let grant = sign_grant(&key, link.id, &hash, exp)?;
    tx.commit().await?;
    let mut resp = SiteResponse::json(200, &json!({"grant": grant, "expires_at": DateTime::<Utc>::from_timestamp(exp, 0)}));
    resp.headers = guest_headers();
    Ok(resp)
}

/// `GET /links/{token}/content?file=&inline=1`: one file's current version. View links serve
/// only inline previews of images and PDFs; every delivery counts against `max_downloads`.
async fn fetch(k: &Kernel, req: &SiteRequest, token: &str) -> Result<SiteResponse> {
    let q = query(req);
    let q = Params(&q);
    let inline = q.flag("inline");
    let mut tx = k.db.tenant_tx(req.tenant).await?;
    let (link, item) = active_link(&mut tx, req.tenant, token).await?;
    gate(&mut tx, req, &link).await?;
    let file = within(&mut tx, req.tenant, &item, q.uuid("file").map_err(|_| gone())?, Kind::File).await?;
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select stored_file, content_type from e_drive_file_version where tenant_id = $1 and file = $2 and version_no = $3")
            .bind(req.tenant)
            .bind(file.id)
            .bind(file.version_no)
            .fetch_optional(&mut *tx)
            .await?;
    let (object, ctype) = row.ok_or_else(gone)?;
    let object: Uuid = object.and_then(|o| o.parse().ok()).ok_or_else(gone)?;
    let ctype = ctype.unwrap_or_else(|| "application/octet-stream".into());
    let preview = inline && content::inline_ok(&ctype);
    if link.access != "Download" && !preview {
        return Err(gone());
    }
    // Claimed under the row lock of this update: concurrent fetches never exceed max_downloads.
    let counted: Option<i64> = sqlx::query_scalar(
        "update e_drive_link set download_count = coalesce(download_count, 0) + 1, last_accessed_at = now() \
         where tenant_id = $1 and id = $2 and not revoked and (expires_at is null or expires_at > now()) \
         and (coalesce(max_downloads, 0) = 0 or coalesce(download_count, 0) < max_downloads) returning download_count",
    )
    .bind(req.tenant)
    .bind(link.id)
    .fetch_optional(&mut *tx)
    .await?;
    counted.ok_or_else(gone)?;
    let guest = Ctx::system(req.tenant, k.registry.schema(req.tenant).await?);
    tree::log(&mut tx, &guest, &file, if preview { "Public View" } else { "Public Download" }, json!({"link": link.id, "version": file.version_no})).await?;
    tx.commit().await?;
    let data = files::read(k, &guest, object).await?;
    let mut headers = guest_headers();
    headers.push(("content-disposition".into(), content::disposition(preview, &file.name)));
    headers.push(("x-content-type-options".into(), "nosniff".into()));
    headers.push(("content-security-policy".into(), "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox".into()));
    Ok(SiteResponse { status: 200, content_type: if preview { ctype } else { content::served_type(&ctype).to_string() }, headers, body: data })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_random_and_only_hashed() {
        let (a, ha) = new_token();
        let (b, hb) = new_token();
        assert_ne!(a, b);
        assert!(well_formed(&a) && well_formed(&b));
        assert_eq!(ha, token_hash(&a));
        assert_eq!(ha.len(), 64);
        assert_ne!(ha, hb);
        assert!(!well_formed("short") && !well_formed(&format!("{}!", &a[..42])) && !well_formed(&format!("{a}x")));
    }

    #[test]
    fn grants_bind_key_link_password_and_time() {
        let (key, other_key) = ([7u8; 32], [8u8; 32]);
        let (link, other_link) = (Uuid::now_v7(), Uuid::now_v7());
        let now = 1_800_000_000;
        let g = sign_grant(&key, link, "$argon2id$hash-1", now + 3600).unwrap();
        assert!(grant_valid(&key, link, "$argon2id$hash-1", &g, now));
        assert!(!grant_valid(&key, link, "$argon2id$hash-1", &g, now + 3600), "expired");
        assert!(!grant_valid(&other_key, link, "$argon2id$hash-1", &g, now), "another tenant's key");
        assert!(!grant_valid(&key, other_link, "$argon2id$hash-1", &g, now), "another link");
        assert!(!grant_valid(&key, link, "$argon2id$hash-2", &g, now), "the password changed");
        let (exp, sig) = g.split_once('.').unwrap();
        let stretched = format!("{}.{sig}", exp.parse::<i64>().unwrap() + 86_400);
        assert!(!grant_valid(&key, link, "$argon2id$hash-1", &stretched, now), "the expiry is signed");
        assert!(!grant_valid(&key, link, "$argon2id$hash-1", "garbage", now));
    }
}

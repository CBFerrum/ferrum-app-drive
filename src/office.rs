//! Online editing over WOPI (Ferrum docs/plan/spike-s1-collabora.md). An editor server the
//! operator runs (Collabora Online, or ONLYOFFICE Docs in WOPI mode) opens a Drive file with a
//! token bound to the workspace, the file, the user and an expiry. It reads the file here, locks it
//! while it is open and saves each change as a new version, all with the user's own Drive rights.
//!
//! The operator turns it on with `FERRUM_OFFICE_URL` (the editor server as this server reaches it,
//! for `/hosting/discovery`) and `FERRUM_OFFICE_WOPI_URL` (this server as the editor server reaches
//! it). `FERRUM_OFFICE_IPS`, when set, lists the only addresses WOPI calls are accepted from.
//
// ponytail: WOPI proof signatures are not checked (the stock Collabora image publishes no proof
// key); the token and FERRUM_OFFICE_IPS guard the endpoints. Add the check once SiteRequest keeps
// the raw URL the signature covers.

use crate::acl::{Grants, Level};
use crate::files::{self, Content};
use crate::tree::{self, Item, Kind};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ferrum_kernel::{Ctx, Error, Kernel, Result, SiteRequest, SiteResponse, Tx};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// How long a token opens a file for; reopening the editor gets a new one.
const TOKEN_SECONDS: i64 = 10 * 3600;
const DISCOVERY_TTL: Duration = Duration::from_secs(600);
const MAX_DISCOVERY: usize = 4 << 20;

struct Config {
    office: String,
    wopi: String,
    ips: Vec<String>,
}

fn config() -> Option<Config> {
    let var = |name: &str| std::env::var(name).ok().map(|v| v.trim().trim_end_matches('/').to_string()).filter(|v| !v.is_empty());
    Some(Config {
        office: var("FERRUM_OFFICE_URL")?,
        wopi: var("FERRUM_OFFICE_WOPI_URL")?,
        ips: var("FERRUM_OFFICE_IPS").map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default(),
    })
}

/// What an editor server offers: its page per (extension, action), from `/hosting/discovery`.
#[derive(Debug, Default)]
pub struct Discovery {
    actions: BTreeMap<(String, String), String>,
}

impl Discovery {
    pub fn parse(xml: &str) -> Discovery {
        let mut actions = BTreeMap::new();
        for tag in xml.split('<').filter_map(|t| t.strip_prefix("action ")) {
            let a = attributes(tag);
            if let (Some(ext), Some(name), Some(src)) = (a.get("ext"), a.get("name"), a.get("urlsrc")) {
                // Optional Microsoft-style parameters (<ui=UI_LLCC&>) are left out.
                let src = src.split('<').next().unwrap_or_default().to_string();
                actions.entry((ext.to_ascii_lowercase(), name.clone())).or_insert(src);
            }
        }
        Discovery { actions }
    }

    /// The editor page for files with extension `ext`: editing when wanted and offered, else viewing.
    pub fn page(&self, ext: &str, edit: bool) -> Option<(&'static str, &str)> {
        let get = |action: &'static str| self.actions.get(&(ext.to_string(), action.to_string())).map(|s| (action, s.as_str()));
        if edit { get("edit").or_else(|| get("view")) } else { get("view").or_else(|| get("edit")) }
    }
}

fn attributes(tag: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut rest = tag;
    while let Some(eq) = rest.find("=\"") {
        let key = rest[..eq].rsplit(char::is_whitespace).next().unwrap_or_default().to_string();
        let after = &rest[eq + 2..];
        let Some(end) = after.find('"') else { break };
        let value = after[..end].replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&");
        out.insert(key, value);
        rest = &after[end + 1..];
    }
    out
}

static DISCOVERY: Mutex<Option<(String, Instant, Arc<Discovery>)>> = Mutex::new(None);

async fn discovery(k: &Kernel, cfg: &Config) -> Result<Arc<Discovery>> {
    if let Some((url, at, d)) = DISCOVERY.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        && *url == cfg.office
        && at.elapsed() < DISCOVERY_TTL
    {
        return Ok(d.clone());
    }
    let unavailable = |e: String| Error::Unavailable(format!("the editor server: {e}"));
    let url = format!("{}/hosting/discovery", cfg.office);
    // The operator's own editor server, usually beside Ferrum: private addresses allowed.
    let (client, parsed) = k.vetted_client(&url, true, Duration::from_secs(10), "Ferrum Drive").await?;
    let res = client.get(parsed).send().await.map_err(|e| unavailable(e.to_string()))?;
    if !res.status().is_success() {
        return Err(unavailable(format!("{url} answered {}", res.status())));
    }
    let bytes = res.bytes().await.map_err(|e| unavailable(e.to_string()))?;
    if bytes.len() > MAX_DISCOVERY {
        return Err(unavailable("its discovery document is too large".into()));
    }
    let d = Arc::new(Discovery::parse(&String::from_utf8_lossy(&bytes)));
    if d.actions.is_empty() {
        return Err(unavailable(format!("{url} lists no editors")));
    }
    *DISCOVERY.lock().unwrap_or_else(|e| e.into_inner()) = Some((cfg.office.clone(), Instant::now(), d.clone()));
    Ok(d)
}

fn token_mac(key: &[u8], tenant: Uuid, file: Uuid, user: Uuid, exp: i64) -> Result<Hmac<Sha256>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(Error::internal)?;
    mac.update(b"ferrum-drive-wopi:");
    for id in [tenant, file, user] {
        mac.update(id.as_bytes());
    }
    mac.update(&exp.to_be_bytes());
    Ok(mac)
}

/// `<user>.<expiry>.<mac>`: the workspace and the file are in the URL the token is used with.
fn sign(key: &[u8], tenant: Uuid, file: Uuid, user: Uuid, exp: i64) -> Result<String> {
    Ok(format!("{user}.{exp}.{}", URL_SAFE_NO_PAD.encode(token_mac(key, tenant, file, user, exp)?.finalize().into_bytes())))
}

/// The user a token was made for, if it is genuine, for this file and not expired (constant time).
fn verify(key: &[u8], tenant: Uuid, file: Uuid, token: &str, now: i64) -> Option<Uuid> {
    let mut parts = token.split('.');
    let (Some(user), Some(exp), Some(sig), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return None };
    let (Ok(user), Ok(exp), Ok(sig)) = (user.parse::<Uuid>(), exp.parse::<i64>(), URL_SAFE_NO_PAD.decode(sig)) else { return None };
    (exp > now && token_mac(key, tenant, file, user, exp).ok()?.verify_slice(&sig).is_ok()).then_some(user)
}

fn encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn writable(ctx: &Ctx, g: &Grants, item: &Item) -> bool {
    item.level(g) >= Level::Edit && files::check_lock(ctx, item).is_ok()
}

/// `POST /api/app/drive/editor/{file}` (`action=view` to only read): the editor page for the file
/// and the token to post to it, as `{url, access_token, access_token_ttl, name, action}`.
pub async fn launch(k: &Kernel, ctx: &Ctx, file: Uuid, want_edit: bool) -> Result<Value> {
    let cfg = config().ok_or_else(|| Error::Unavailable("online editing is not set up on this server (FERRUM_OFFICE_URL, FERRUM_OFFICE_WOPI_URL)".into()))?;
    let d = discovery(k, &cfg).await?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let g = Grants::load(&mut tx, ctx).await?;
    let item = tree::open_kind(&mut tx, ctx, &g, Kind::File, file, Level::View, false).await?;
    let ext = item.name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    let (action, page) =
        d.page(&ext, want_edit && writable(ctx, &g, &item)).ok_or_else(|| Error::invalid(format!("{} cannot be opened in the editor", item.name)))?;
    let exp = chrono::Utc::now().timestamp() + TOKEN_SECONDS;
    let token = sign(&crate::sharing::tenant_key(&mut tx, ctx.tenant).await?, ctx.tenant, file, ctx.user, exp)?;
    tree::log(&mut tx, ctx, &item, "Open online", json!({"action": action})).await?;
    tx.commit().await?;
    let mut sys = k.db.system_tx().await?;
    let slug: String = sqlx::query_scalar("select slug from tenant where id = $1").bind(ctx.tenant).fetch_one(&mut *sys).await?;
    sys.commit().await?;
    let src = format!("{}/api/site/{slug}/drive/wopi/files/{file}", cfg.wopi);
    let sep = if page.ends_with('?') || page.ends_with('&') {
        ""
    } else if page.contains('?') {
        "&"
    } else {
        "?"
    };
    Ok(json!({
        "url": format!("{page}{sep}WOPISrc={}", encode(&src)),
        "access_token": token,
        "access_token_ttl": exp * 1000,
        "name": item.name,
        "action": action,
    }))
}

fn status(code: u16) -> SiteResponse {
    SiteResponse { status: code, content_type: "text/plain".into(), headers: vec![], body: vec![] }
}

fn conflict(current: Option<&str>, reason: &str) -> SiteResponse {
    let mut r = status(409);
    r.headers = vec![("X-WOPI-Lock".into(), current.unwrap_or_default().into()), ("X-WOPI-LockFailureReason".into(), reason.into())];
    r
}

/// `/api/site/{tenant}/drive/wopi/files/{file}[/contents]`, called by the editor server.
pub async fn wopi(k: &Kernel, req: &SiteRequest, path: &[&str]) -> Result<SiteResponse> {
    let Some(cfg) = config() else { return Ok(status(404)) };
    if !cfg.ips.is_empty() && !cfg.ips.contains(&req.client_ip) {
        return Ok(status(403));
    }
    let (file, contents) = match path {
        ["wopi", "files", id] => (*id, false),
        ["wopi", "files", id, "contents"] => (*id, true),
        _ => return Ok(status(404)),
    };
    let Ok(file) = file.parse::<Uuid>() else { return Ok(status(404)) };
    let token = req.query.get("access_token").and_then(Value::as_str).unwrap_or_default();
    let mut tx = k.db.tenant_tx(req.tenant).await?;
    let key = crate::sharing::tenant_key(&mut tx, req.tenant).await?;
    tx.commit().await?;
    let Some(user) = verify(&key, req.tenant, file, token, chrono::Utc::now().timestamp()) else { return Ok(status(401)) };
    // A deactivated person's tokens stop working with their account.
    let Ok(ctx) = k.load_ctx(req.tenant, user, None, format!("wopi-{}", Uuid::now_v7())).await else { return Ok(status(401)) };
    let header = |name: &str| req.headers.get(name).and_then(Value::as_str);
    let mut tx = k.db.tenant_tx(req.tenant).await?;
    let g = Grants::load(&mut tx, &ctx).await?;
    let out = match (req.method.as_str(), contents, header("x-wopi-override").unwrap_or_default()) {
        ("GET", false, _) => check_file_info(&mut tx, &ctx, &g, file).await,
        ("GET", true, _) => get_file(k, &mut tx, &ctx, &g, file).await,
        ("POST", true, "PUT") => put_file(k, &mut tx, &ctx, &g, file, req).await,
        ("POST", false, op) => lock(&mut tx, &ctx, &g, file, op, header("x-wopi-lock"), header("x-wopi-oldlock")).await,
        _ => Ok(status(501)),
    };
    match out {
        Ok(r) => {
            tx.commit().await?;
            Ok(r)
        }
        // Files a person may not see answer as missing ones do.
        Err(Error::NotFound(_) | Error::Forbidden(_)) => Ok(status(404)),
        Err(Error::Conflict(m)) => Ok(conflict(None, &m)),
        Err(e @ (Error::Invalid(_) | Error::Validation(_))) => Ok(SiteResponse::text(400, "text/plain", e.to_string())),
        Err(e) => Err(e),
    }
}

async fn check_file_info(tx: &mut Tx, ctx: &Ctx, g: &Grants, file: Uuid) -> Result<SiteResponse> {
    let item = tree::open_kind(tx, ctx, g, Kind::File, file, Level::View, false).await?;
    let can_write = writable(ctx, g, &item);
    Ok(SiteResponse::json(
        200,
        &json!({
            "BaseFileName": item.name,
            "Size": item.size,
            "Version": item.version_no.to_string(),
            "LastModifiedTime": item.modified_at.to_rfc3339(),
            "OwnerId": item.owner.clone().unwrap_or_else(|| "team".into()),
            "UserId": ctx.user.to_string(),
            "UserFriendlyName": ctx.full_name,
            "UserCanWrite": can_write,
            "ReadOnly": !can_write,
            "SupportsLocks": true,
            "SupportsGetLock": true,
            "SupportsUpdate": true,
            "SupportsRename": false,
            "UserCanRename": false,
            "UserCanNotWriteRelative": true,
        }),
    ))
}

async fn get_file(k: &Kernel, tx: &mut Tx, ctx: &Ctx, g: &Grants, file: Uuid) -> Result<SiteResponse> {
    let d = files::prepare_download(tx, ctx, g, file, None).await?;
    let body = files::read(k, ctx, d.object).await?;
    files::logged(tx, ctx, &d).await?;
    Ok(SiteResponse { status: 200, content_type: "application/octet-stream".into(), headers: vec![("X-WOPI-ItemVersion".into(), d.version.to_string())], body })
}

async fn current_lock(tx: &mut Tx, tenant: Uuid, file: Uuid) -> Result<Option<String>> {
    Ok(sqlx::query_scalar("select lock from drive_wopi_lock where tenant_id = $1 and file = $2 and expires_at > now()")
        .bind(tenant)
        .bind(file)
        .fetch_optional(&mut **tx)
        .await?)
}

async fn set_lock(tx: &mut Tx, tenant: Uuid, file: Uuid, lock: &str) -> Result<()> {
    // WOPI locks lapse after 30 minutes without a RefreshLock.
    sqlx::query(
        "insert into drive_wopi_lock (tenant_id, file, lock, expires_at) values ($1, $2, $3, now() + interval '30 minutes') \
         on conflict (tenant_id, file) do update set lock = excluded.lock, expires_at = excluded.expires_at",
    )
    .bind(tenant)
    .bind(file)
    .bind(lock)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn put_file(k: &Kernel, tx: &mut Tx, ctx: &Ctx, g: &Grants, file: Uuid, req: &SiteRequest) -> Result<SiteResponse> {
    let item = tree::open_kind(tx, ctx, g, Kind::File, file, Level::Edit, false).await?;
    let current = current_lock(tx, ctx.tenant, file).await?;
    let given = req.headers.get("x-wopi-lock").and_then(Value::as_str);
    match current.as_deref() {
        Some(cur) if given != Some(cur) => return Ok(conflict(Some(cur), "locked by another editor session")),
        // WOPI: a file with content is saved only by the session holding its lock.
        None if item.size > 0 => return Ok(conflict(None, "not locked")),
        _ => {}
    }
    let flag = |name: &str| req.headers.get(name).and_then(Value::as_str) == Some("true");
    let comment = if flag("x-cool-wopi-isautosave") {
        "Autosaved online"
    } else if flag("x-cool-wopi-isexitsave") {
        "Saved online on closing"
    } else {
        "Saved online"
    };
    let saved = files::upload_version(k, ctx, tx, g, file, &Content::new(&item.name, &req.body), Some(comment), false).await?;
    let version = saved.get("version").and_then(Value::as_i64).unwrap_or(item.version_no + 1);
    let mut r = SiteResponse::json(200, &json!({"LastModifiedTime": crate::now()}));
    r.headers.push(("X-WOPI-ItemVersion".into(), version.to_string()));
    Ok(r)
}

async fn lock(tx: &mut Tx, ctx: &Ctx, g: &Grants, file: Uuid, op: &str, given: Option<&str>, old: Option<&str>) -> Result<SiteResponse> {
    let level = if op == "GET_LOCK" { Level::View } else { Level::Edit };
    tree::open_kind(tx, ctx, g, Kind::File, file, level, false).await?;
    let current = current_lock(tx, ctx.tenant, file).await?;
    let cur = current.as_deref();
    let tenant = ctx.tenant;
    match (op, given) {
        ("GET_LOCK", _) => {
            let mut r = status(200);
            r.headers.push(("X-WOPI-Lock".into(), cur.unwrap_or_default().into()));
            Ok(r)
        }
        (_, None) | (_, Some("")) => Ok(status(400)),
        ("LOCK", Some(lock)) if lock.len() > 1024 => Ok(status(400)),
        // UnlockAndRelock: the old lock must be the current one.
        ("LOCK", Some(lock)) if old.is_some() => {
            if cur != old {
                return Ok(conflict(cur, "the old lock is not the current one"));
            }
            set_lock(tx, tenant, file, lock).await?;
            Ok(status(200))
        }
        ("LOCK", Some(lock)) => match cur {
            Some(c) if c != lock => Ok(conflict(cur, "locked by another editor session")),
            _ => {
                set_lock(tx, tenant, file, lock).await?;
                Ok(status(200))
            }
        },
        ("REFRESH_LOCK", Some(lock)) if cur == Some(lock) => {
            set_lock(tx, tenant, file, lock).await?;
            Ok(status(200))
        }
        ("UNLOCK", Some(lock)) if cur == Some(lock) => {
            sqlx::query("delete from drive_wopi_lock where tenant_id = $1 and file = $2").bind(tenant).bind(file).execute(&mut **tx).await?;
            Ok(status(200))
        }
        ("REFRESH_LOCK" | "UNLOCK", _) => Ok(conflict(cur, "the lock is not the current one")),
        _ => Ok(status(501)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const COLLABORA: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<wopi-discovery><net-zone name="external-http">
<app favIconUrl="http://office:9980/browser/42745e44dd/images/x-office-document.svg" name="writer">
<action default="true" ext="docx" name="edit" urlsrc="http://office:9980/browser/42745e44dd/cool.html?"/>
<action ext="odt" name="edit" urlsrc="http://office:9980/browser/42745e44dd/cool.html?"/>
</app>
<app name="Microsoft-style"><action ext="pdf" name="view" urlsrc="https://ms.example/wv/wordviewerframe.aspx?&lt;ui=UI_LLCC&amp;&gt;&amp;embed=1"/></app>
</net-zone></wopi-discovery>"#;

    #[test]
    fn discovery_pages() {
        let d = Discovery::parse(COLLABORA);
        assert_eq!(d.page("docx", true), Some(("edit", "http://office:9980/browser/42745e44dd/cool.html?")));
        assert_eq!(d.page("docx", false), Some(("edit", "http://office:9980/browser/42745e44dd/cool.html?")), "no view action: the editor");
        assert_eq!(d.page("pdf", true), Some(("view", "https://ms.example/wv/wordviewerframe.aspx?")), "placeholders dropped, entities read");
        assert_eq!(d.page("png", true), None);
    }

    #[test]
    fn tokens_are_bound_to_workspace_file_user_and_time() {
        let key = [7u8; 32];
        let (t, f, u) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        let token = sign(&key, t, f, u, 1_000).unwrap();
        assert_eq!(verify(&key, t, f, &token, 999), Some(u));
        assert_eq!(verify(&key, t, f, &token, 1_000), None, "expired");
        assert_eq!(verify(&key, t, Uuid::now_v7(), &token, 999), None, "another file");
        assert_eq!(verify(&key, Uuid::now_v7(), f, &token, 999), None, "another workspace");
        assert_eq!(verify(&[8u8; 32], t, f, &token, 999), None, "another key");
        let forged = token.replacen(&u.to_string(), &Uuid::now_v7().to_string(), 1);
        assert_eq!(verify(&key, t, f, &forged, 999), None, "another user");
        assert_eq!(verify(&key, t, f, "nonsense", 999), None);
        assert_eq!(encode("http://h:1/a b?c=d"), "http%3A%2F%2Fh%3A1%2Fa%20b%3Fc%3Dd");
    }
}

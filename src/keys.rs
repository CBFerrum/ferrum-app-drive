//! Drive's keys, from its own key in the vault (Ferrum docs/operations.md, "The vault"). Editor tokens (`wopi-tokens`)
//! and the grants a link's password is exchanged for (`link-grants`) are signed with keys derived for those purposes
//! when needed and kept nowhere. What they sign names the version of Drive's key it came from, so that a new version
//! (`ferrum task vault_rotate level:owner … owner:drive`) leaves what was signed before working until it expires.
//!
//! Until 0.17 one key signed both, kept unsealed in `drive_secret`, where whoever could read the database could forge
//! them. It signs nothing any more. What it signed lives ten hours at most (an editor token; a grant lives one), so it
//! moves into the vault, sealed, as Drive's secret `old-signing-key`, to check those until ten hours and a day after it
//! stopped signing (`drive_secret.retired_at`; the day covers replicas of the build before still signing with it while
//! an upgrade rolls out, or after a rollback), and from then on it checks nothing. It moves the first time something it
//! signed is checked, or at Drive's next upkeep, once: under its row's lock, taken without waiting. A sandbox never
//! takes it, so a link or token of the live workspace does not open the copy. The previous build reads `drive_secret`
//! still; its rows go in the release after this one.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Duration, Utc};
use ferrum_kernel::vault::{Derived, New, Rule, Scope, Vault, Zeroizing};
use ferrum_kernel::{Error, Kernel, Result};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::sync::RwLock;
use uuid::Uuid;

/// Editor tokens (WOPI).
pub const WOPI: &str = "wopi-tokens";
/// The grants a password-protected link's password is exchanged for.
pub const GRANTS: &str = "link-grants";
/// The key that signed both until 0.17, sealed in the vault while what it signed may still be presented.
const OLD: &str = "old-signing-key";
/// How long after it stopped signing the old key still checks what it signed: the longest-lived of it (an editor
/// token, ten hours), and a day for replicas of the previous build signing with it during an upgrade or a rollback.
fn old_for() -> Duration {
    Duration::hours(10) + Duration::days(1)
}

/// Drive's handle on the vault, from its registration.
static VAULT: RwLock<Option<Vault>> = RwLock::new(None);

/// Keeps the handle the registration gave Drive.
// ponytail: the last registration's handle serves the whole process (`ferrum start` sets the server up twice and serves
// with the second); keep it in what is registered if one process ever serves two kernels at once.
pub(crate) fn remember(v: Vault) {
    *VAULT.write().unwrap_or_else(|e| e.into_inner()) = Some(v);
}

fn handle() -> Result<Vault> {
    VAULT.read().unwrap_or_else(|e| e.into_inner()).clone().ok_or_else(|| Error::Unavailable("Drive was registered without its vault handle".into()))
}

/// What a person or a caller is told when the vault cannot be used; why goes to the log.
fn unavailable(e: Error) -> Error {
    match e {
        Error::Unavailable(why) | Error::Retryable(why) => {
            // The start's log and the doctor say why the vault is closed; this is the same reason, for each use.
            tracing::debug!("Drive's keys: {why}");
            Error::Unavailable("Drive cannot sign or check links and editor sessions right now: its keys are unavailable".into())
        }
        e => e,
    }
}

/// The key for `purpose` in the workspace now, with the version it came from.
pub(crate) async fn current(k: &Kernel, tenant: Uuid, purpose: &str) -> Result<Derived> {
    handle()?.derive(k, Scope::Workspace(tenant), purpose).await.map_err(unavailable)
}

/// The key for `purpose` from version `version` of Drive's key; none once that version is gone.
pub(crate) async fn at(k: &Kernel, tenant: Uuid, purpose: &str, version: i32) -> Result<Option<Derived>> {
    match handle()?.derive_at(k, Scope::Workspace(tenant), purpose, version).await {
        Ok(d) => Ok(Some(d)),
        Err(Error::NotFound(_)) => Ok(None),
        Err(e) => Err(unavailable(e)),
    }
}

/// HMAC-SHA256 of `message` under `key`.
pub(crate) fn mac(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes keys of any length");
    m.update(message);
    m.finalize().into_bytes().to_vec()
}

/// Whether `tag` is [`mac`] of `message` under `key` (in constant time).
pub(crate) fn mac_ok(key: &[u8], message: &[u8], tag: &[u8]) -> bool {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes keys of any length");
    m.update(message);
    m.verify_slice(tag).is_ok()
}

/// `message` signed with a key derived from version `version` of Drive's key, as `v{version}.{mac}`.
pub(crate) fn signed(key: &[u8], version: i32, message: &[u8]) -> String {
    format!("v{version}.{}", URL_SAFE_NO_PAD.encode(mac(key, message)))
}

/// The version a signature names (`v3`), if it names one.
pub(crate) fn version(part: &str) -> Option<i32> {
    part.strip_prefix('v')?.parse().ok().filter(|v| *v > 0)
}

/// Whether `tag` is `message` signed by the old key, while it still checks anything: moved into the vault first, if it
/// has not been yet. Never in a sandbox.
pub(crate) async fn old_ok(k: &Kernel, tenant: Uuid, message: &[u8], tag: &[u8]) -> Result<bool> {
    let v = handle()?;
    let scope = Scope::Workspace(tenant);
    for first in [true, false] {
        match v.verify(k, scope, OLD, message, tag).await {
            Ok(good) => return Ok(good),
            Err(Error::NotFound(_)) if first => {
                if !move_old(k, &v, tenant).await? {
                    return Ok(false);
                }
            }
            // Gone, or past what it still checks ("… expired on …").
            Err(Error::NotFound(_) | Error::Forbidden(_)) => return Ok(false),
            Err(e) => return Err(unavailable(e)),
        }
    }
    Ok(false)
}

/// What `drive_secret` holds for a workspace: its key, and when it stopped signing (now, if it has not yet).
type Row = (Vec<u8>, DateTime<Utc>);

/// Moves the workspace's old key into the vault, once, if it still checks anything: whether the vault holds it now. One
/// replica at a time: the row is locked without waiting, and one that finds it locked lets go of its connection and
/// asks again, so that no replica holds a connection while it waits for the one moving it, which needs a second one.
async fn move_old(k: &Kernel, v: &Vault, tenant: Uuid) -> Result<bool> {
    let scope = Scope::Workspace(tenant);
    let sandbox = k.outward(tenant).await.is_err();
    for _ in 0..50 {
        let mut tx = k.db.tenant_tx(tenant).await?;
        let row: std::result::Result<Option<Row>, sqlx::Error> =
            sqlx::query_as("select secret, coalesce(retired_at, now()) from drive_secret where tenant_id = $1 for update nowait")
                .bind(tenant)
                .fetch_optional(&mut *tx)
                .await;
        let (secret, retired) = match row {
            Ok(Some(row)) => row,
            Ok(None) => return Ok(false),
            // Another replica is moving it.
            Err(sqlx::Error::Database(d)) if d.code().as_deref() == Some("55P03") => {
                drop(tx);
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
            // The table is gone (a later release dropped it): nothing to move.
            Err(sqlx::Error::Database(d)) if d.code().as_deref() == Some("42P01") => return Ok(false),
            Err(e) => return Err(e.into()),
        };
        let secret = Zeroizing::new(secret);
        let until = retired + old_for();
        let held = if sandbox || until <= Utc::now() {
            false
        } else if v.describe(k, scope, OLD).await.map_err(unavailable)?.is_some() {
            true
        } else {
            let rule = Rule { expires_at: Some(until), ..Default::default() };
            v.set(k, scope, OLD, New::Value(secret), rule).await.map_err(unavailable)?;
            true
        };
        sqlx::query("update drive_secret set retired_at = $2 where tenant_id = $1 and retired_at is null").bind(tenant).bind(retired).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(held);
    }
    Err(Error::Unavailable("Drive's old key is being moved into the vault: try again in a moment".into()))
}

/// Upkeep: the old keys of workspaces where none has moved yet, so that every one is in the vault before the release
/// after this one removes `drive_secret`'s rows. Nothing while the vault is closed.
pub(crate) async fn move_waiting(k: &Kernel) -> Result<()> {
    let Ok(v) = handle() else { return Ok(()) };
    let waiting: Vec<Uuid> = {
        let mut tx = k.db.system_tx().await?;
        let found = sqlx::query_scalar("select tenant_id from drive_secret where retired_at is null order by tenant_id limit 200").fetch_all(&mut *tx).await;
        tx.commit().await?;
        match found {
            Ok(found) => found,
            Err(sqlx::Error::Database(d)) if d.code().as_deref() == Some("42P01") => return Ok(()),
            Err(e) => return Err(e.into()),
        }
    };
    for tenant in waiting {
        match move_old(k, &v, tenant).await {
            Ok(_) => {}
            Err(Error::Unavailable(_)) => return Ok(()),
            Err(e) => tracing::warn!(%tenant, "moving Drive's old key into the vault: {e}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_name_their_version_and_macs_check_in_constant_time() {
        assert_eq!((version("v3"), version("v0"), version("3"), version("vx"), version("v-1")), (Some(3), None, None, None, None));
        let tag = mac(b"key", b"message");
        assert!(mac_ok(b"key", b"message", &tag) && !mac_ok(b"key", b"massage", &tag) && !mac_ok(b"other", b"message", &tag));
        assert!(old_for() > Duration::hours(10), "longer than anything the old key signed lives");
    }
}

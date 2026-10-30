//! Working together on Drive's files (Ferrum docs/plan/collaboration.md, C1): who a comment tells,
//! who has a file open now, and asking for access to an item one cannot see.
//!
//! * Comments name people (`mentions`, emails). Those who may see the file are told in the bell
//!   and by mail; the file's owner is told of comments by others.
//! * Presence: open pages report every 30 seconds that their person is viewing or editing a file
//!   ([`heartbeat`]); anyone who may see the file sees who did so in the last 90 seconds.
//! * A request for access tells the item's owner, or a team folder's managers, once a day per
//!   person. The asker always gets the same answer, so a request reveals nothing about the item.

use crate::acl::{Grants, Level};
use crate::files;
use crate::sharing;
use crate::tree::{self, Item, Kind};
use ferrum_kernel::{Ctx, Error, Kernel, Result, Tx, notify};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const MAX_MENTIONS: usize = 20;
/// How long a page counts as open after its last report.
const PRESENT_SECONDS: f64 = 90.0;

/// Whether `user` may see `file`, by their own rights.
async fn can_see(k: &Kernel, tx: &mut Tx, tenant: Uuid, user: Uuid, file: Uuid) -> Result<bool> {
    let Ok(ctx) = k.load_ctx(tenant, user, None, format!("drive-collab-{}", Uuid::now_v7())).await else { return Ok(false) };
    let g = Grants::load(tx, &ctx).await?;
    Ok(tree::open_kind(tx, &ctx, &g, Kind::File, file, Level::View, false).await.is_ok())
}

/// Tells the people a new comment on `f` mentions, if they may see the file, and the file's owner;
/// answers whom it mentioned.
pub async fn tell_about_comment(k: &Kernel, ctx: &Ctx, tx: &mut Tx, f: &Item, body: &str, mentions: &[String]) -> Result<Vec<String>> {
    let by = if ctx.full_name.is_empty() { ctx.email.clone() } else { ctx.full_name.clone() };
    let snippet: String = body.chars().take(140).collect();
    let me = files::actor(ctx);
    let mut told = BTreeSet::new();
    for email in mentions.iter().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).take(MAX_MENTIONS) {
        if Some(&email) == me.as_ref() || told.contains(&email) {
            continue;
        }
        let Some((user, _)) = tree::user_by_email(tx, ctx.tenant, &email).await? else { continue };
        if !can_see(k, tx, ctx.tenant, user, f.id).await? {
            continue;
        }
        notify::send(tx, ctx.tenant, user, &format!("{by} mentioned you on \"{}\"", f.name), Some(&snippet), Some("DriveFile"), Some(f.id)).await?;
        sharing::mail(k, ctx, tx, &email, &format!("{by} mentioned you in Drive"), &format!("{by} mentioned you in a comment on \"{}\"", f.name)).await?;
        told.insert(email);
    }
    if let Some(owner) = f.owner.as_ref().filter(|o| Some(*o) != me.as_ref() && !told.contains(*o))
        && let Some((user, _)) = tree::user_by_email(tx, ctx.tenant, owner).await?
    {
        notify::send(tx, ctx.tenant, user, &format!("{by} commented on \"{}\"", f.name), Some(&snippet), Some("DriveFile"), Some(f.id)).await?;
    }
    Ok(told.into_iter().collect())
}

/// `POST /api/app/drive/presence/{file}?mode=view|edit|gone`: the caller has the file open (or
/// closed it). Answers who else has it open now, as `{file, present: [{name, mode, editor?}]}`.
pub async fn heartbeat(k: &Kernel, ctx: &Ctx, file: Uuid, mode: &str) -> Result<Value> {
    if !matches!(mode, "view" | "edit" | "gone") {
        return Err(Error::field("mode", "must be view, edit or gone"));
    }
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let g = Grants::load(&mut tx, ctx).await?;
    let f = tree::open_kind(&mut tx, ctx, &g, Kind::File, file, Level::View, false).await?;
    if mode == "gone" {
        sqlx::query("delete from drive_presence where tenant_id = $1 and file = $2 and user_id = $3")
            .bind(ctx.tenant)
            .bind(f.id)
            .bind(ctx.user)
            .execute(&mut *tx)
            .await?;
    } else {
        let name: String = if ctx.full_name.is_empty() { &ctx.email } else { &ctx.full_name }.chars().take(200).collect();
        sqlx::query(
            "insert into drive_presence (tenant_id, file, user_id, name, mode, seen_at) values ($1, $2, $3, $4, $5, now()) \
             on conflict (tenant_id, file, user_id) do update set name = excluded.name, mode = excluded.mode, seen_at = excluded.seen_at",
        )
        .bind(ctx.tenant)
        .bind(f.id)
        .bind(ctx.user)
        .bind(name)
        .bind(mode)
        .execute(&mut *tx)
        .await?;
    }
    let others = present_on(&mut tx, ctx, &[f.id]).await?.remove(&f.id).unwrap_or_default();
    tx.commit().await?;
    Ok(json!({"file": f.id, "present": others}))
}

/// `GET /api/app/drive/presence?files=<id>,…`: who has each of these files open now, for the files
/// the caller may see (at most 500), as `{present: {<file>: [{name, mode, editor?}]}}`.
pub async fn present(k: &Kernel, ctx: &Ctx, ids: &[Uuid]) -> Result<Value> {
    if ids.len() > 500 {
        return Err(Error::field("files", "at most 500 files"));
    }
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let g = Grants::load(&mut tx, ctx).await?;
    let visible: Vec<Uuid> = crate::ops::visible_in_order(&mut tx, ctx.tenant, &g, ids).await?.into_iter().map(|i| i.id).collect();
    let by_file = present_on(&mut tx, ctx, &visible).await?;
    tx.commit().await?;
    Ok(json!({"present": by_file}))
}

/// Who other than the caller reported one of `files` (already checked for the caller) open lately.
/// Whoever edits a file a browser editor holds is in that editor (`"editor": "browser"`): it is one
/// person's at a time, so nobody can join them (Ferrum docs/plan/collaboration.md, C2).
async fn present_on(tx: &mut Tx, ctx: &Ctx, files: &[Uuid]) -> Result<BTreeMap<Uuid, Vec<Value>>> {
    let rows: Vec<(Uuid, String, String, bool)> = sqlx::query_as(
        "select p.file, p.name, p.mode, coalesce(p.mode = 'edit' and l.lock like 'browser:%', false) \
         from drive_presence p \
         left join drive_wopi_lock l on l.tenant_id = p.tenant_id and l.file = p.file and l.expires_at > now() \
         where p.tenant_id = $1 and p.file = any($2) and p.user_id <> $3 \
         and p.seen_at > now() - make_interval(secs => $4) order by p.file, p.mode desc, p.name",
    )
    .bind(ctx.tenant)
    .bind(files)
    .bind(ctx.user)
    .bind(PRESENT_SECONDS)
    .fetch_all(&mut **tx)
    .await?;
    let mut out: BTreeMap<Uuid, Vec<Value>> = BTreeMap::new();
    for (file, name, mode, browser) in rows {
        let mut one = json!({"name": name, "mode": mode});
        if browser {
            one["editor"] = json!("browser");
        }
        out.entry(file).or_default().push(one);
    }
    Ok(out)
}

/// `request_access {item, message?}`: asks the item's owner, or a team folder's managers, to share
/// it with the caller. Answers `{requested: true}` whatever the item is, or `{has_access: true}`
/// when the caller may already see it.
pub async fn request_access(k: &Kernel, ctx: &Ctx, tx: &mut Tx, g: &Grants, item: Uuid, message: Option<&str>) -> Result<Value> {
    if tree::open(tx, ctx, g, item, Level::View, false).await.is_ok() {
        return Ok(json!({"has_access": true}));
    }
    let message: Option<String> = message.map(str::trim).filter(|m| !m.is_empty()).map(|m| m.chars().take(500).collect());
    let answer = json!({"requested": true});
    let Some(target) = (match tree::load_kind(tx, ctx.tenant, Kind::File, item, false).await? {
        Some(f) => Some(f),
        None => tree::load_kind(tx, ctx.tenant, Kind::Folder, item, false).await?,
    })
    .filter(|i| !i.trashed) else {
        return Ok(answer);
    };
    // Once a day per item and person: an older request is replaced, a recent one stands.
    let fresh: Option<Uuid> = sqlx::query_scalar(
        "insert into drive_access_request (tenant_id, item, requester, asked_at) values ($1, $2, $3, now()) \
         on conflict (tenant_id, item, requester) do update set asked_at = excluded.asked_at \
         where drive_access_request.asked_at < now() - interval '1 day' returning item",
    )
    .bind(ctx.tenant)
    .bind(target.id)
    .bind(ctx.user)
    .fetch_optional(&mut **tx)
    .await?;
    if fresh.is_none() {
        return Ok(answer);
    }
    let managers: Vec<String> = match &target.owner {
        Some(owner) if !target.is_team => vec![owner.clone()],
        _ => {
            sqlx::query_scalar("select member from e_drive_folder__members where tenant_id = $1 and parent_id = $2 and role = 'Manager' order by member")
                .bind(ctx.tenant)
                .bind(target.top())
                .fetch_all(&mut **tx)
                .await?
        }
    };
    let by = if ctx.full_name.is_empty() { ctx.email.clone() } else { format!("{} ({})", ctx.full_name, ctx.email) };
    for email in managers {
        let Some((user, _)) = tree::user_by_email(tx, ctx.tenant, &email).await? else { continue };
        let title = format!("{by} asks for access to \"{}\"", target.name);
        notify::send(tx, ctx.tenant, user, &title, message.as_deref(), Some(target.kind.entity()), Some(target.id)).await?;
        sharing::mail(k, ctx, tx, &email, &format!("{by} asks for access in Drive"), &format!("{by} asks for access to \"{}\"", target.name)).await?;
    }
    tree::log(tx, ctx, &target, "Access Requested", json!({"by": files::actor(ctx)})).await?;
    Ok(answer)
}

/// Upkeep: forgets presence older than ten minutes and requests older than thirty days.
pub async fn forget(tx: &mut Tx, tenant: Uuid) -> Result<u64> {
    let gone =
        sqlx::query("delete from drive_presence where tenant_id = $1 and seen_at < now() - interval '10 minutes'").bind(tenant).execute(&mut **tx).await?;
    let old =
        sqlx::query("delete from drive_access_request where tenant_id = $1 and asked_at < now() - interval '30 days'").bind(tenant).execute(&mut **tx).await?;
    Ok(gone.rows_affected() + old.rows_affected())
}

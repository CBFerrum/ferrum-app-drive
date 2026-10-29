//! Every-minute upkeep for each workspace using Drive: items in the trash longer than the
//! workspace keeps them are deleted for good (with their stored files and quota), and expired
//! shares are removed (they already grant nothing; this keeps lists short). Bounded per run;
//! every item is deleted in its own transaction and re-checked under lock, so concurrent runs and
//! restores never conflict.

use crate::ops::purge;
use crate::tree::{self, Kind};
use ferrum_kernel::{Ctx, Error, Kernel, Result, with_retry};
use serde_json::json;
use uuid::Uuid;

const BATCH: i64 = 50;

pub async fn run(k: &Kernel) -> Result<()> {
    let tenants: Vec<Uuid> = {
        let mut tx = k.db.system_tx().await?;
        let t = sqlx::query_scalar(
            "select p.tenant_id from installed_package p join tenant t on t.id = p.tenant_id where p.name = 'drive' and t.status = 'active' order by 1",
        )
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        t
    };
    let mut first_error = None;
    for tenant in tenants {
        if let Err(e) = for_tenant(k, tenant).await {
            tracing::warn!(%tenant, "drive upkeep failed: {e}");
            first_error.get_or_insert(e);
        }
    }
    first_error.map_or(Ok(()), Err)
}

async fn for_tenant(k: &Kernel, tenant: Uuid) -> Result<()> {
    let schema = k.registry.schema(tenant).await?;
    if !schema.packages.iter().any(|p| p == "drive") {
        return Ok(());
    }
    let mut ctx = Ctx::system(tenant, schema);
    ctx.request_id = format!("drive-upkeep-{}", Uuid::now_v7());
    let purged = purge_trash(k, &ctx).await?;
    let expired = expire_shares(k, &ctx).await?;
    if purged + expired > 0 {
        tracing::info!(%tenant, purged, expired, "drive upkeep");
    }
    Ok(())
}

/// Deletes for good what has been in the trash longer than the workspace keeps it.
pub async fn purge_trash(k: &Kernel, ctx: &Ctx) -> Result<usize> {
    let days = {
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        let days = tree::settings(&mut tx, ctx.tenant).await?.trash_days;
        tx.commit().await?;
        days
    };
    let due: Vec<(Uuid, String)> = {
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        let due = sqlx::query_as(
            "(select id, 'folder' from e_drive_folder where tenant_id = $1 and trashed and trashed_at < now() - make_interval(days => $2) order by trashed_at limit $3) \
             union all (select id, 'file' from e_drive_file where tenant_id = $1 and trashed and trashed_at < now() - make_interval(days => $2) order by trashed_at limit $3)",
        )
        .bind(ctx.tenant)
        .bind(days as i32)
        .bind(BATCH)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        due
    };
    let mut purged = 0;
    for (id, kind) in due {
        let kind = if kind == "file" { Kind::File } else { Kind::Folder };
        let done = with_retry(|| async {
            let mut tx = k.db.tenant_tx(ctx.tenant).await?;
            // Still in the trash and still overdue (a restore, a new trashing or an earlier purge may have won).
            let cutoff = chrono::Utc::now() - chrono::Duration::days(days);
            let item = match tree::load_kind(&mut tx, ctx.tenant, kind, id, true).await? {
                Some(i) if i.trashed && i.trashed_at.is_some_and(|t| t < cutoff) => i,
                _ => {
                    tx.rollback().await?;
                    return Ok(false);
                }
            };
            purge(ctx, &mut tx, &item).await?;
            tx.commit().await?;
            Ok(true)
        })
        .await;
        match done {
            Ok(true) => purged += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!(%id, "drive: could not purge a trashed item: {e}"),
        }
    }
    Ok(purged)
}

/// Removes expired shares, noting each in the item's activity.
pub async fn expire_shares(k: &Kernel, ctx: &Ctx) -> Result<usize> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let gone: Vec<(Option<Uuid>, Option<Uuid>, Option<String>, Option<String>)> = sqlx::query_as(
        "delete from e_drive_share where tenant_id = $1 and id in (select id from e_drive_share where tenant_id = $1 and expires_at <= now() \
         order by expires_at limit 500) returning file, folder, email, role",
    )
    .bind(ctx.tenant)
    .fetch_all(&mut *tx)
    .await?;
    for (file, folder, email, role) in &gone {
        if let Some(item) = tree::load(&mut tx, ctx.tenant, file.or(*folder).ok_or_else(|| Error::internal("share without item"))?).await? {
            tree::log(&mut tx, ctx, &item, "Share Expired", json!({"email": email, "role": role})).await?;
        }
    }
    tx.commit().await?;
    Ok(gone.len())
}

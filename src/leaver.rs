//! When someone leaves the workspace (`ferrum.user.deprovisioned`): what Drive does beyond moving
//! names, which `handover` in the package declares. What they had checked out opens up, shares made
//! to them end, and whoever takes over gets to what they kept in their own space. Their own public
//! links need someone to answer for them: the successor if there is one, or else they stop, unless the
//! workspace says to keep them (Drive Settings). A link that belongs to the workspace stays, answered
//! for by whoever it names; one they answered for passes to their successor, or stops. Every link it
//! touches says whose departure it went through and what became of it, for an access review (FEO-036).
//! All of it is safe to repeat.

use crate::acl::Level;
use crate::tree;
use async_trait::async_trait;
use ferrum_kernel::lifecycle::DEPROVISIONED_TOPIC;
use ferrum_kernel::outbox::Event;
use ferrum_kernel::{Ctx, Doc, EventSink, Kernel, Result};
use serde_json::{Value, json};
use uuid::Uuid;

pub struct Departures;

#[async_trait]
impl EventSink for Departures {
    async fn on_event(&self, k: &Kernel, ev: &Event) -> Result<()> {
        if ev.topic != DEPROVISIONED_TOPIC {
            return Ok(());
        }
        let tenant = ev.tenant_id;
        let schema = k.registry.schema(tenant).await?;
        if schema.entity("DriveSpace").is_none() {
            return Ok(());
        }
        let email = ev.payload.get("email").and_then(Value::as_str).unwrap_or_default().trim().to_lowercase();
        if email.is_empty() {
            return Ok(());
        }
        let to = ev.payload.get("reassign_to").and_then(Value::as_str).and_then(|s| s.parse::<Uuid>().ok());
        let ctx = Ctx::system(tenant, schema);
        let mut tx = k.db.tenant_tx(tenant).await?;
        sqlx::query("update e_drive_file set locked_by = null, locked_at = null where tenant_id = $1 and lower(locked_by::text) = $2")
            .bind(tenant)
            .bind(&email)
            .execute(&mut *tx)
            .await?;
        sqlx::query("delete from e_drive_share where tenant_id = $1 and lower(email::text) = $2").bind(tenant).bind(&email).execute(&mut *tx).await?;
        let successor: Option<String> = match to {
            Some(to) => {
                sqlx::query_scalar("select email::text from app_user where tenant_id = $1 and id = $2").bind(tenant).bind(to).fetch_optional(&mut *tx).await?
            }
            None => None,
        };
        // The workspace's links someone else answers for stay as they are; it is noted.
        sqlx::query(
            "update e_drive_link set left_by = $2, on_leaving = 'Stayed', left_at = now() \
             where tenant_id = $1 and lower(shared_by::text) = $2 and belongs_to = 'The Workspace' and lower(answerable::text) <> $2 and not revoked \
             and lower(coalesce(left_by::text, '')) <> $2",
        )
        .bind(tenant)
        .bind(&email)
        .execute(&mut *tx)
        .await?;
        // The workspace's links they answered for: their successor answers now, or they stop.
        match &successor {
            Some(next) => {
                sqlx::query(
                    "update e_drive_link set answerable = $3, left_by = $2, on_leaving = 'Passed On', left_at = now() \
                 where tenant_id = $1 and belongs_to = 'The Workspace' and lower(answerable::text) = $2 and not revoked",
                )
                .bind(tenant)
                .bind(&email)
                .bind(next)
                .execute(&mut *tx)
                .await?
            }
            None => {
                sqlx::query(
                    "update e_drive_link set revoked = true, revoked_at = now(), left_by = $2, on_leaving = 'Stopped', left_at = now() \
                 where tenant_id = $1 and belongs_to = 'The Workspace' and lower(answerable::text) = $2 and not revoked",
                )
                .bind(tenant)
                .bind(&email)
                .execute(&mut *tx)
                .await?
            }
        };
        match &successor {
            Some(next) => {
                sqlx::query(
                    "update e_drive_link set shared_by = $3, left_by = $2, on_leaving = 'Passed On', left_at = now() \
                     where tenant_id = $1 and lower(shared_by::text) = $2 and coalesce(belongs_to, 'Its Maker') = 'Its Maker' and not revoked",
                )
                .bind(tenant)
                .bind(&email)
                .bind(next)
                .execute(&mut *tx)
                .await?;
                if let Some(space) = tree::space_of(&mut tx, tenant, &email).await? {
                    let shared: bool =
                        sqlx::query_scalar("select exists (select 1 from e_drive_share where tenant_id = $1 and folder = $2 and lower(email::text) = $3)")
                            .bind(tenant)
                            .bind(space.root)
                            .bind(next.to_lowercase())
                            .fetch_one(&mut *tx)
                            .await?;
                    if !shared {
                        let mut share = Doc::new();
                        for (key, v) in [
                            ("folder", json!(space.root)),
                            ("email", json!(next)),
                            ("permission", json!(Level::Manage.name())),
                            ("level", json!(Level::Manage.as_int())),
                        ] {
                            share.insert(key.into(), v);
                        }
                        k.insert_tx(&ctx, &mut tx, "DriveShare", share).await?;
                    }
                }
            }
            None => {
                let keep: Option<String> = sqlx::query_scalar("select links_after_leaving from e_drive_settings where tenant_id = $1 limit 1")
                    .bind(tenant)
                    .fetch_optional(&mut *tx)
                    .await?
                    .flatten();
                // Links made before Drive knew whose a link is have no `belongs_to`: they are their maker's.
                let (revoke, outcome) = if keep.as_deref() == Some("Keep") { (false, "Kept") } else { (true, "Stopped") };
                sqlx::query(
                    "update e_drive_link set revoked = $3, revoked_at = case when $3 then now() end, left_by = $2, on_leaving = $4, left_at = now() \
                     where tenant_id = $1 and lower(shared_by::text) = $2 and coalesce(belongs_to, 'Its Maker') = 'Its Maker' and not revoked \
                     and lower(coalesce(left_by::text, '')) <> $2",
                )
                .bind(tenant)
                .bind(&email)
                .bind(revoke)
                .bind(outcome)
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }
}

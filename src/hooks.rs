//! Document hooks. Drive's records change only through Drive's own code (which writes with an
//! engine context naming the person), never through the generic records API, imports or MCP;
//! Drive Spaces are the exception: a person creates their own (an administrator anyone's), and
//! every Drive operation is an action on one.

use crate::{acl, ops, tree};
use async_trait::async_trait;
use ferrum_domain::util::{elevated, id, s};
use ferrum_kernel::{Doc, DocHook, Error, HookCtx, Result};
use serde_json::{Value, json};
use uuid::Uuid;

const DIRECT: &str = "Drive records change only through Drive's actions: run them on your Drive Space";

/// Refuses direct writes and deletes of folders, files, versions, shares, links, comments,
/// stars, templates and activity.
pub struct Guard;

#[async_trait]
impl DocHook for Guard {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, _doc: &mut Doc) -> Result<()> {
        if hc.ctx.is_system { Ok(()) } else { Err(Error::Forbidden(DIRECT.into())) }
    }
    async fn before_delete(&self, hc: &mut HookCtx<'_>, _doc: &Doc) -> Result<()> {
        if hc.ctx.is_system { Ok(()) } else { Err(Error::Forbidden(DIRECT.into())) }
    }
}

/// A person's Drive: created with its top folder; its owner, usage and top folder are Drive's.
pub struct SpaceHook;

#[async_trait]
impl DocHook for SpaceHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let admin = acl::is_admin(hc.ctx);
        if doc.contains_key("created_at") {
            // An existing space: only its quota may change (read-only fields are already kept).
            let space = id(doc, "id").ok_or_else(|| Error::internal("space without id"))?;
            let owner: String = sqlx::query_scalar("select owner from e_drive_space where tenant_id = $1 and id = $2")
                .bind(hc.ctx.tenant)
                .bind(space)
                .fetch_one(&mut **hc.tx)
                .await?;
            if s(doc, "owner").map(str::to_lowercase).as_deref() != Some(owner.as_str()) {
                return Err(Error::field("owner", "a space keeps its owner"));
            }
            if doc.get("quota_mb").is_none_or(Value::is_null) {
                doc.insert("quota_mb".into(), json!(tree::settings(hc.tx, hc.ctx.tenant).await?.user_quota_mb));
            }
            return Ok(());
        }
        let me = hc.ctx.email.trim().to_lowercase();
        let owner = match s(doc, "owner").map(str::to_lowercase) {
            None => me,
            Some(o) if o == me || admin => o,
            Some(_) => return Err(Error::Forbidden("you can only create your own Drive space".into())),
        };
        let user = tree::user_by_email(hc.tx, hc.ctx.tenant, &owner).await?;
        let Some((_, full_name)) = user else { return Err(Error::field("owner", format!("{owner} is not an active user of this workspace"))) };
        if !admin || doc.get("quota_mb").is_none_or(Value::is_null) {
            doc.insert("quota_mb".into(), json!(tree::settings(hc.tx, hc.ctx.tenant).await?.user_quota_mb));
        }
        doc.insert("owner".into(), json!(owner));
        doc.insert("full_name".into(), json!(full_name));
        doc.insert("used_bytes".into(), json!(0));
        doc.insert("root_folder".into(), Value::Null);
        Ok(())
    }

    async fn after_save(&self, hc: &mut HookCtx<'_>, doc: &Doc, old: Option<&Doc>) -> Result<()> {
        if old.is_some() || id(doc, "root_folder").is_some() {
            return Ok(());
        }
        let space = id(doc, "id").ok_or_else(|| Error::internal("space without id"))?;
        let root = Uuid::now_v7();
        let mut folder = Doc::new();
        for (k, v) in [("id", json!(root)), ("name", json!("My Folders")), ("owner", json!(s(doc, "owner"))), ("ancestors", json!([]))] {
            folder.insert(k.into(), v);
        }
        hc.kernel.insert_tx(&elevated(hc.ctx), hc.tx, "DriveFolder", folder).await?;
        let mut v = Doc::new();
        v.insert("root_folder".into(), json!(root));
        hc.kernel.set_values_tx(hc.ctx, hc.tx, "DriveSpace", space, v).await
    }

    async fn before_delete(&self, hc: &mut HookCtx<'_>, _doc: &Doc) -> Result<()> {
        let _ = hc;
        Err(Error::Forbidden("Drive spaces are kept with their files; deactivate the person instead".into()))
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        let space = tree::space_from_doc(doc)?;
        ops::run(hc.kernel, hc.ctx, hc.tx, &space, name, params).await.map(Some)
    }
}

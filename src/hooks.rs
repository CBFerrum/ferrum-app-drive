//! Document hooks. Drive's records change only through Drive's own code (which writes with an
//! engine context naming the person), never through the generic records API, imports or MCP;
//! Drive Spaces are the exception: a person creates their own (an administrator anyone's), and
//! every Drive operation is an action on one.

use crate::{acl, ops, tree};
use async_trait::async_trait;
use ferrum_domain::util::{elevated, id, s};
use ferrum_kernel::{Ctx, Doc, DocHook, Error, HookCtx, Result};
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

    /// `facts` of a file (hidden, read-only): what another app may know of it now, whatever its sharing (the action's
    /// permission, or an app's approved use, is the right to it): its type, size, digest and version, whether it or a
    /// folder around it is in the trash, the stored file holding its current version, and the version asked for. It
    /// only reads, and logs nothing: it is not a download.
    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        if hc.entity.def.name != "DriveFile" || name != "facts" {
            return Ok(None);
        }
        let file = id(doc, "id").ok_or_else(|| Error::internal("file without id"))?;
        let item = tree::load_kind(hc.tx, hc.ctx.tenant, tree::Kind::File, file, false).await?.ok_or_else(tree::missing)?;
        let asked = match ops::Params(params).int("version")? {
            Some(v) if v < 1 => return Err(Error::field("version", "must be a whole number from 1")),
            v => v,
        };
        let wanted: Vec<i64> = [Some(item.version_no), asked].into_iter().flatten().collect();
        type Row = (i64, Option<String>, Option<i64>, Option<String>, Option<String>);
        let rows: Vec<Row> = sqlx::query_as(
            "select version_no, stored_file, size, sha256, content_type from e_drive_file_version where tenant_id = $1 and file = $2 and version_no = any($3)",
        )
        .bind(hc.ctx.tenant)
        .bind(file)
        .bind(&wanted)
        .fetch_all(&mut **hc.tx)
        .await?;
        let row = |no: i64| rows.iter().find(|r| r.0 == no);
        let stored = |no: i64| row(no).and_then(|r| r.1.as_deref()).and_then(|s| s.parse::<Uuid>().ok());
        let version = asked.and_then(row).map(|(no, _, size, sha256, content_type)| {
            json!({"version_no": no, "stored_file": stored(*no), "size": size.unwrap_or(0), "sha256": sha256, "content_type": content_type})
        });
        let trashed = tree::in_trash(hc.tx, hc.ctx.tenant, &item).await?;
        Ok(Some(json!({
            "file": item.id, "name": item.name, "file_type": item.file_type, "content_type": item.content_type, "size": item.size,
            "sha256": item.sha256, "version_no": item.version_no, "trashed": trashed, "stored_file": stored(item.version_no), "version": version,
        })))
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

    /// Runs a Drive operation. The gate runs one for a person (another app's call, a configured action's effect) as the
    /// system acting for them, which Drive's sharing would take for an administrator (`acl::is_admin`): such a call runs
    /// with the person's own rights instead, on their own space, so it reaches exactly what they could themselves.
    /// The system with no person behind it keeps its reach.
    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        let space = tree::space_from_doc(doc)?;
        if hc.ctx.is_system && !hc.ctx.user.is_nil() {
            let zone = hc.ctx.zone.as_deref().and_then(|z| z.name());
            let own = hc.kernel.load_ctx_in(hc.ctx.tenant, hc.ctx.user, zone, hc.ctx.request_id.clone()).await?;
            // As the call stood, as the platform's jobs and approvals keep it: a step-up not made is still not made, and
            // the automations it sets going count on from its depth.
            let own = Ctx { proof: hc.ctx.proof, depth: hc.ctx.depth, origin: hc.ctx.origin.clone(), ..own };
            if space.owner.to_lowercase() != own.email.trim().to_lowercase() && !acl::is_admin(&own) {
                return Err(Error::Forbidden("Drive's actions run on your own Drive space".into()));
            }
            return ops::run(hc.kernel, &own, hc.tx, &space, name, params).await.map(Some);
        }
        ops::run(hc.kernel, hc.ctx, hc.tx, &space, name, params).await.map(Some)
    }
}

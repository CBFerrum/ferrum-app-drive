//! Storage reports for Drive administrators (they read every Drive file; the report catalog
//! checks that before running): storage by person, by team folder and by file type, the largest
//! files and what is shared publicly. Sizes are bytes and MB of every version, trash included —
//! what quotas count.

use async_trait::async_trait;
use ferrum_domain::reports::{Params, ReportSource, col, read_tx};
use ferrum_kernel::{Ctx, Error, Kernel, Result, Tx};
use serde_json::{Value, json};
use std::collections::HashMap;

pub struct DriveReports;

fn select(name: &str, label: &str, options: &[&str]) -> Value {
    json!({"name": name, "label": label, "type": "select", "options": options, "default": options[0]})
}

fn mb(bytes: i64) -> Value {
    json!(format!("{:.1}", bytes as f64 / 1_048_576.0))
}

#[async_trait]
impl ReportSource for DriveReports {
    fn catalog(&self) -> Vec<Value> {
        let r = |name: &str, label: &str, params: Vec<Value>| json!({"name": name, "label": label, "module": "drive", "entity": "DriveFile", "params": params});
        vec![
            r("drive_storage_by_user", "Drive Storage by Person", vec![]),
            r("drive_storage_by_team", "Drive Storage by Team Folder", vec![]),
            r("drive_storage_by_type", "Drive Storage by File Type", vec![]),
            r(
                "drive_largest_files",
                "Largest Drive Files",
                vec![select("limit", "Show", &["50", "100", "500"]), select("include_trash", "Include Trash", &["No", "Yes"])],
            ),
            r("drive_shared_externally", "Drive Public Links", vec![select("status", "Links", &["Active", "All"])]),
        ]
    }

    async fn run(&self, k: &Kernel, ctx: &Ctx, name: &str, params: &HashMap<String, String>) -> Result<Value> {
        let p = Params { raw: params };
        let mut tx = read_tx(k, ctx).await?;
        let out = match name {
            "drive_storage_by_user" => by_user(&mut tx, ctx).await?,
            "drive_storage_by_team" => by_team(&mut tx, ctx).await?,
            "drive_storage_by_type" => by_type(&mut tx, ctx).await?,
            "drive_largest_files" => largest(&mut tx, ctx, &p).await?,
            "drive_shared_externally" => public_links(&mut tx, ctx, &p).await?,
            _ => return Err(Error::NotFound(format!("report {name}"))),
        };
        tx.rollback().await?;
        Ok(out)
    }
}

/// Files with all their versions' bytes and trash state (`t`: in the trash itself or under a trashed folder).
const FILE_USE: &str = "select f.id, f.root, f.file_type, coalesce(f.size, 0) as size, \
     coalesce((select sum(v.size) from e_drive_file_version v where v.tenant_id = f.tenant_id and v.file = f.id), 0)::bigint as stored, \
     (f.trashed or exists (select 1 from e_drive_folder t where t.tenant_id = f.tenant_id and t.trashed and f.ancestors ? t.id::text)) as in_trash \
     from e_drive_file f where f.tenant_id = $1";

fn usage_row(label: (&str, Value), quota_mb: Option<i64>, used: i64, files: i64, stored: i64, trash: i64) -> Value {
    let pct = quota_mb.filter(|q| *q > 0).map(|q| json!(format!("{:.1}", used as f64 * 100.0 / (q as f64 * 1_048_576.0))));
    json!({label.0: label.1, "quota_mb": quota_mb.filter(|q| *q > 0), "used_mb": mb(used), "used_pct": pct, "files": files, "stored_mb": mb(stored), "trash_mb": mb(trash)})
}

async fn by_user(tx: &mut Tx, ctx: &Ctx) -> Result<Value> {
    let sql = format!(
        "with u as ({FILE_USE}) select s.owner, s.full_name, s.quota_mb, coalesce(s.used_bytes, 0), count(u.id), coalesce(sum(u.stored), 0)::bigint, \
         coalesce(sum(u.stored) filter (where u.in_trash), 0)::bigint from e_drive_space s left join u on u.root = s.root_folder \
         where s.tenant_id = $1 group by s.id, s.owner, s.full_name, s.quota_mb, s.used_bytes order by coalesce(s.used_bytes, 0) desc, s.owner"
    );
    let rows: Vec<(String, Option<String>, Option<i64>, i64, i64, i64, i64)> =
        sqlx::query_as(sqlx::AssertSqlSafe(sql)).bind(ctx.tenant).fetch_all(&mut **tx).await?;
    let used: i64 = rows.iter().map(|r| r.3).sum();
    Ok(json!({
        "columns": [col("owner", "Person", "data"), col("full_name", "Name", "data"), col("quota_mb", "Quota (MB)", "int"), col("used_mb", "Used (MB)", "decimal"),
                    col("used_pct", "Used %", "percent"), col("files", "Files", "int"), col("stored_mb", "Stored (MB)", "decimal"), col("trash_mb", "In Trash (MB)", "decimal")],
        "rows": rows.into_iter().map(|(owner, name, quota, used, files, stored, trash)| {
            let mut r = usage_row(("owner", json!(owner)), quota, used, files, stored, trash);
            r["full_name"] = json!(name);
            r
        }).collect::<Vec<_>>(),
        "totals": {"used_mb": mb(used)},
    }))
}

async fn by_team(tx: &mut Tx, ctx: &Ctx) -> Result<Value> {
    let sql = format!(
        "with u as ({FILE_USE}) select t.name, t.trashed, t.quota_mb, coalesce(t.used_bytes, 0), \
         (select count(*) from e_drive_folder__members m where m.tenant_id = t.tenant_id and m.parent_id = t.id), count(u.id), \
         coalesce(sum(u.stored), 0)::bigint, coalesce(sum(u.stored) filter (where u.in_trash), 0)::bigint \
         from e_drive_folder t left join u on u.root = t.id where t.tenant_id = $1 and t.is_team \
         group by t.id, t.tenant_id, t.name, t.trashed, t.quota_mb, t.used_bytes order by coalesce(t.used_bytes, 0) desc, lower(t.name)"
    );
    let rows: Vec<(String, bool, Option<i64>, i64, i64, i64, i64, i64)> =
        sqlx::query_as(sqlx::AssertSqlSafe(sql)).bind(ctx.tenant).fetch_all(&mut **tx).await?;
    let used: i64 = rows.iter().map(|r| r.3).sum();
    Ok(json!({
        "columns": [col("team", "Team Folder", "data"), col("members", "Members", "int"), col("quota_mb", "Quota (MB)", "int"), col("used_mb", "Used (MB)", "decimal"),
                    col("used_pct", "Used %", "percent"), col("files", "Files", "int"), col("stored_mb", "Stored (MB)", "decimal"), col("trash_mb", "In Trash (MB)", "decimal")],
        "rows": rows.into_iter().map(|(name, trashed, quota, used, members, files, stored, trash)| {
            let label = if trashed { format!("{name} (in trash)") } else { name };
            let mut r = usage_row(("team", json!(label)), quota, used, files, stored, trash);
            r["members"] = json!(members);
            r
        }).collect::<Vec<_>>(),
        "totals": {"used_mb": mb(used)},
    }))
}

async fn by_type(tx: &mut Tx, ctx: &Ctx) -> Result<Value> {
    let sql = format!(
        "with u as ({FILE_USE}) select coalesce(u.file_type, 'Other'), count(*), coalesce(sum(u.size), 0)::bigint, coalesce(sum(u.stored), 0)::bigint \
         from u group by 1 order by 4 desc, 1"
    );
    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(sql)).bind(ctx.tenant).fetch_all(&mut **tx).await?;
    let (files, current, stored) = rows.iter().fold((0, 0, 0), |a, r| (a.0 + r.1, a.1 + r.2, a.2 + r.3));
    Ok(json!({
        "columns": [col("file_type", "Type", "data"), col("files", "Files", "int"), col("current_mb", "Current Versions (MB)", "decimal"),
                    col("stored_mb", "All Versions (MB)", "decimal")],
        "rows": rows.into_iter().map(|(t, n, cur, all)| json!({"file_type": t, "files": n, "current_mb": mb(cur), "stored_mb": mb(all)})).collect::<Vec<_>>(),
        "totals": {"files": files, "current_mb": mb(current), "stored_mb": mb(stored)},
    }))
}

async fn largest(tx: &mut Tx, ctx: &Ctx, p: &Params<'_>) -> Result<Value> {
    let limit: i64 = p.str("limit").and_then(|l| l.parse().ok()).unwrap_or(50).clamp(1, 500);
    let trash = p.str("include_trash") == Some("Yes");
    let sql = format!(
        "with u as ({FILE_USE}) select f.id, f.name, f.file_type, coalesce(f.owner, t.name), u.size, u.stored, \
         (select count(*) from e_drive_file_version v where v.tenant_id = f.tenant_id and v.file = f.id), coalesce(f.modified_at, f.created_at), u.in_trash \
         from u join e_drive_file f on f.tenant_id = $1 and f.id = u.id left join e_drive_folder t on t.tenant_id = f.tenant_id and t.id = f.root and t.is_team \
         where ($3 or not u.in_trash) order by u.stored desc, f.name limit $2"
    );
    type R = (uuid::Uuid, String, Option<String>, Option<String>, i64, i64, i64, chrono::DateTime<chrono::Utc>, bool);
    let rows: Vec<R> = sqlx::query_as(sqlx::AssertSqlSafe(sql)).bind(ctx.tenant).bind(limit).bind(trash).fetch_all(&mut **tx).await?;
    Ok(json!({
        "columns": [col("name", "File", "data"), col("file_type", "Type", "data"), col("owner", "Person or Team", "data"), col("size_mb", "Size (MB)", "decimal"),
                    col("stored_mb", "All Versions (MB)", "decimal"), col("versions", "Versions", "int"), col("modified_at", "Modified", "datetime"),
                    col("in_trash", "In Trash", "check")],
        "rows": rows.into_iter().map(|(id, name, ty, owner, size, stored, versions, at, in_trash)| json!({
            "id": id, "name": name, "file_type": ty, "owner": owner, "size_mb": mb(size), "stored_mb": mb(stored), "versions": versions,
            "modified_at": at, "in_trash": in_trash,
        })).collect::<Vec<_>>(),
    }))
}

async fn public_links(tx: &mut Tx, ctx: &Ctx, p: &Params<'_>) -> Result<Value> {
    let all = p.str("status") == Some("All");
    type R = (
        uuid::Uuid,
        Option<String>,
        String,
        String,
        bool,
        Option<chrono::DateTime<chrono::Utc>>,
        Option<i64>,
        i64,
        bool,
        Option<String>,
        chrono::DateTime<chrono::Utc>,
        Option<chrono::DateTime<chrono::Utc>>,
        bool,
        Option<String>,
    );
    let rows: Vec<R> = sqlx::query_as(
        "select l.id, coalesce(f.name, d.name), case when l.file is null then 'Folder' else 'File' end, l.access, coalesce(l.has_password, false), l.expires_at, \
         l.max_downloads, coalesce(l.download_count, 0), l.revoked, l.shared_by, l.created_at, l.last_accessed_at, \
         (not l.revoked and (l.expires_at is null or l.expires_at > now()) and (coalesce(l.max_downloads, 0) = 0 or coalesce(l.download_count, 0) < l.max_downloads)), l.email::text \
         from e_drive_link l left join e_drive_file f on f.tenant_id = l.tenant_id and f.id = l.file \
         left join e_drive_folder d on d.tenant_id = l.tenant_id and d.id = l.folder where l.tenant_id = $1 order by l.created_at desc limit 5000",
    )
    .bind(ctx.tenant)
    .fetch_all(&mut **tx)
    .await?;
    let rows: Vec<Value> = rows
        .into_iter()
        .filter(|r| all || r.12)
        .map(|(id, name, kind, access, pw, exp, max, count, revoked, by, at, last, active, email)| {
            json!({"id": id, "item": name, "kind": kind, "access": access, "password": pw, "expires_at": exp, "max_downloads": max, "downloads": count,
                   "revoked": revoked, "shared_by": by, "created_at": at, "last_accessed_at": last, "active": active, "sent_to": email})
        })
        .collect();
    Ok(json!({
        "columns": [col("item", "Item", "data"), col("kind", "Kind", "data"), col("access", "Access", "data"), col("password", "Password", "check"),
                    col("expires_at", "Expires", "datetime"), col("downloads", "Downloads", "int"), col("max_downloads", "Download Limit", "int"),
                    col("shared_by", "Created By", "data"), col("sent_to", "Sent To", "data"), col("created_at", "Created", "datetime"),
                    col("last_accessed_at", "Last Opened", "datetime"),
                    col("active", "Active", "check")],
        "totals": {"links": rows.len()},
        "rows": rows,
    }))
}

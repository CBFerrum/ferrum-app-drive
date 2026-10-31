//! Drive's data layer: items (files and folders) and their place in the tree, liveness (an item
//! is in the trash when it or any enclosing folder was trashed), locks, names, quotas, settings,
//! spaces and the activity log.
//!
//! Concurrency: every change that adds an item to a folder locks that folder's row, so names
//! are checked and taken one writer at a time; changes that rewrite enclosing-folder lists (moving
//! a folder) hold the tree lock of the trees involved exclusively, while adding items holds it
//! shared — so an item is never created under a folder whose position is changing. Quotas are
//! charged with one conditional update: concurrent uploads can never overshoot.

use crate::acl::{Grants, Level};
use chrono::{DateTime, Utc};
use ferrum_domain::util::elevated;
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, Tx};
use serde_json::{Value, json};
use sqlx::AssertSqlSafe;
use sqlx::types::Json;
use std::collections::HashSet;
use uuid::Uuid;

/// The answer for items that do not exist and for items the caller may not see.
pub fn missing() -> Error {
    Error::NotFound("Drive item".into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Folder,
    File,
}

impl Kind {
    pub fn entity(self) -> &'static str {
        match self {
            Kind::Folder => "DriveFolder",
            Kind::File => "DriveFile",
        }
    }
    pub fn table(self) -> &'static str {
        match self {
            Kind::Folder => "e_drive_folder",
            Kind::File => "e_drive_file",
        }
    }
    /// The column naming the enclosing folder.
    pub fn parent_col(self) -> &'static str {
        match self {
            Kind::Folder => "parent",
            Kind::File => "folder",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Kind::Folder => "folder",
            Kind::File => "file",
        }
    }
}

/// Columns every item query selects, the same for both tables.
pub const FOLDER_COLS: &str = "'folder' as kind, a.id, a.name, a.parent, a.root, a.ancestors, a.owner, a.is_team, a.trashed, a.trashed_at, a.colour, \
     0::bigint as size, null::text as content_type, null::text as file_type, 0::bigint as version_no, null::text as sha256, \
     null::text as locked_by, null::timestamptz as locked_at, a.updated_at as modified_at, null::text as modified_by, a.created_at";
pub const FILE_COLS: &str = "'file' as kind, a.id, a.name, a.folder as parent, a.root, a.ancestors, a.owner, false as is_team, a.trashed, a.trashed_at, \
     null::text as colour, coalesce(a.size, 0) as size, a.content_type, a.file_type, coalesce(a.version_no, 0) as version_no, a.sha256, \
     a.locked_by, a.locked_at, coalesce(a.modified_at, a.created_at) as modified_at, a.modified_by, a.created_at";

#[derive(sqlx::FromRow)]
struct Row {
    kind: String,
    id: Uuid,
    name: String,
    parent: Option<Uuid>,
    root: Option<Uuid>,
    ancestors: Option<Json<Vec<Uuid>>>,
    owner: Option<String>,
    is_team: bool,
    trashed: bool,
    trashed_at: Option<DateTime<Utc>>,
    colour: Option<String>,
    size: i64,
    content_type: Option<String>,
    file_type: Option<String>,
    version_no: i64,
    sha256: Option<String>,
    locked_by: Option<String>,
    locked_at: Option<DateTime<Utc>>,
    modified_at: DateTime<Utc>,
    modified_by: Option<String>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct Item {
    pub kind: Kind,
    pub id: Uuid,
    pub name: String,
    /// The enclosing folder (empty on top folders).
    pub parent: Option<Uuid>,
    /// The top folder of the tree (empty on top folders themselves).
    pub root: Option<Uuid>,
    /// Enclosing folders, outermost first.
    pub ancestors: Vec<Uuid>,
    /// Owner of the personal space (empty in team folders).
    pub owner: Option<String>,
    pub is_team: bool,
    pub trashed: bool,
    pub trashed_at: Option<DateTime<Utc>>,
    pub colour: Option<String>,
    pub size: i64,
    pub content_type: Option<String>,
    pub file_type: Option<String>,
    pub version_no: i64,
    pub sha256: Option<String>,
    pub locked_by: Option<String>,
    pub locked_at: Option<DateTime<Utc>>,
    pub modified_at: DateTime<Utc>,
    pub modified_by: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl From<Row> for Item {
    fn from(r: Row) -> Item {
        Item {
            kind: if r.kind == "file" { Kind::File } else { Kind::Folder },
            id: r.id,
            name: r.name,
            parent: r.parent,
            root: r.root,
            ancestors: r.ancestors.map(|a| a.0).unwrap_or_default(),
            owner: r.owner,
            is_team: r.is_team,
            trashed: r.trashed,
            trashed_at: r.trashed_at,
            colour: r.colour,
            size: r.size,
            content_type: r.content_type,
            file_type: r.file_type,
            version_no: r.version_no,
            sha256: r.sha256,
            locked_by: r.locked_by,
            locked_at: r.locked_at,
            modified_at: r.modified_at,
            modified_by: r.modified_by,
            created_at: r.created_at,
        }
    }
}

impl Item {
    /// The top folder of this item's tree (itself for top folders).
    pub fn top(&self) -> Uuid {
        self.root.unwrap_or(self.id)
    }
    /// The enclosing folders of this folder's children.
    pub fn child_ancestors(&self) -> Vec<Uuid> {
        let mut a = self.ancestors.clone();
        a.push(self.id);
        a
    }
    pub fn is_top(&self) -> bool {
        self.kind == Kind::Folder && self.parent.is_none()
    }
    pub fn level(&self, g: &Grants) -> Level {
        g.level(self.id, self.root, &self.ancestors)
    }
    pub fn json(&self, level: Level, starred: bool) -> Value {
        let file = self.kind == Kind::File;
        json!({
            "id": self.id, "kind": self.kind.name(), "name": self.name, "parent": self.parent,
            "team": if self.owner.is_none() { Some(self.top()) } else { None }, "is_team": self.is_team, "owner": self.owner,
            "size": if file { Some(self.size) } else { None }, "content_type": self.content_type, "file_type": self.file_type,
            "version": if file { Some(self.version_no) } else { None }, "sha256": self.sha256,
            "modified_at": self.modified_at, "modified_by": self.modified_by, "created_at": self.created_at,
            "colour": self.colour, "locked_by": self.locked_by, "locked_at": self.locked_at,
            "trashed": self.trashed, "trashed_at": self.trashed_at,
            "permission": level.name(), "starred": starred,
        })
    }
}

/// Loads an item of either kind (no lock).
pub async fn load(tx: &mut Tx, tenant: Uuid, id: Uuid) -> Result<Option<Item>> {
    let sql = format!(
        "select {FOLDER_COLS} from e_drive_folder a where a.tenant_id = $1 and a.id = $2 \
         union all select {FILE_COLS} from e_drive_file a where a.tenant_id = $1 and a.id = $2"
    );
    let row: Option<Row> = sqlx::query_as(AssertSqlSafe(sql)).bind(tenant).bind(id).fetch_optional(&mut **tx).await?;
    Ok(row.map(Item::from))
}

/// Loads an item of a known kind, optionally locking its row.
pub async fn load_kind(tx: &mut Tx, tenant: Uuid, kind: Kind, id: Uuid, lock: bool) -> Result<Option<Item>> {
    let cols = if kind == Kind::Folder { FOLDER_COLS } else { FILE_COLS };
    let sql = format!("select {cols} from {} a where a.tenant_id = $1 and a.id = $2{}", kind.table(), if lock { " for update" } else { "" });
    let row: Option<Row> = sqlx::query_as(AssertSqlSafe(sql)).bind(tenant).bind(id).fetch_optional(&mut **tx).await?;
    Ok(row.map(Item::from))
}

/// Items of a kind by id (no lock), in no particular order.
pub async fn load_many(tx: &mut Tx, tenant: Uuid, kind: Kind, ids: &[Uuid]) -> Result<Vec<Item>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let cols = if kind == Kind::Folder { FOLDER_COLS } else { FILE_COLS };
    let sql = format!("select {cols} from {} a where a.tenant_id = $1 and a.id = any($2)", kind.table());
    let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(sql)).bind(tenant).bind(ids).fetch_all(&mut **tx).await?;
    Ok(rows.into_iter().map(Item::from).collect())
}

/// Runs an item query built with [`FOLDER_COLS`] / [`FILE_COLS`].
pub async fn fetch(tx: &mut Tx, qb: &mut sqlx::QueryBuilder<sqlx::Postgres>) -> Result<Vec<Item>> {
    let rows: Vec<Row> = qb.build_query_as().fetch_all(&mut **tx).await?;
    Ok(rows.into_iter().map(Item::from).collect())
}

/// Folders among `ids` that are in the trash themselves.
pub async fn trashed_folders(tx: &mut Tx, tenant: Uuid, ids: &[Uuid]) -> Result<HashSet<Uuid>> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<Uuid> = sqlx::query_scalar("select id from e_drive_folder where tenant_id = $1 and trashed and id = any($2)")
        .bind(tenant)
        .bind(ids)
        .fetch_all(&mut **tx)
        .await?;
    Ok(rows.into_iter().collect())
}

/// Whether the item is in the trash: trashed itself or inside a trashed folder.
pub async fn in_trash(tx: &mut Tx, tenant: Uuid, item: &Item) -> Result<bool> {
    Ok(item.trashed || !trashed_folders(tx, tenant, &item.ancestors).await?.is_empty())
}

/// Keeps the items that are out of the trash.
pub async fn keep_live(tx: &mut Tx, tenant: Uuid, items: Vec<Item>) -> Result<Vec<Item>> {
    let all: Vec<Uuid> = items.iter().flat_map(|i| i.ancestors.iter().copied()).collect::<HashSet<_>>().into_iter().collect();
    let trashed = trashed_folders(tx, tenant, &all).await?;
    Ok(items.into_iter().filter(|i| !i.trashed && !i.ancestors.iter().any(|a| trashed.contains(a))).collect())
}

fn need(level: Level, needed: Level) -> Result<()> {
    if level < needed {
        return Err(Error::Forbidden(format!("this needs {} access; you have {}", needed.name(), level.name())));
    }
    Ok(())
}

/// An item out of the trash that the caller may act on at `needed` (row locked when `lock`).
/// Missing, invisible and trashed items all answer [`missing`].
pub async fn open(tx: &mut Tx, ctx: &Ctx, g: &Grants, id: Uuid, needed: Level, lock: bool) -> Result<Item> {
    let item = load(tx, ctx.tenant, id).await?.ok_or_else(missing)?;
    let item = if lock { load_kind(tx, ctx.tenant, item.kind, id, true).await?.ok_or_else(missing)? } else { item };
    let level = item.level(g);
    if level < Level::View || in_trash(tx, ctx.tenant, &item).await? {
        return Err(missing());
    }
    need(level, needed)?;
    Ok(item)
}

/// Like [`open`], requiring a kind.
pub async fn open_kind(tx: &mut Tx, ctx: &Ctx, g: &Grants, kind: Kind, id: Uuid, needed: Level, lock: bool) -> Result<Item> {
    let item = open(tx, ctx, g, id, needed, lock).await?;
    if item.kind != kind {
        return Err(missing());
    }
    Ok(item)
}

/// An item the caller trashed (or can see in the trash), for restoring or deleting for good.
pub async fn open_trashed(tx: &mut Tx, ctx: &Ctx, g: &Grants, id: Uuid, needed: Level, lock: bool) -> Result<Item> {
    let item = load(tx, ctx.tenant, id).await?.ok_or_else(missing)?;
    let item = if lock { load_kind(tx, ctx.tenant, item.kind, id, true).await?.ok_or_else(missing)? } else { item };
    let level = item.level(g);
    if level < Level::View || !item.trashed {
        return Err(missing());
    }
    need(level, needed)?;
    Ok(item)
}

/// Holds the tree locks of `trees`: exclusive for those in `exclusive`, shared otherwise. Always
/// in id order, so two transactions never wait for each other in a circle.
pub async fn lock_trees(tx: &mut Tx, tenant: Uuid, shared: &[Uuid], exclusive: &[Uuid]) -> Result<()> {
    let mut all: Vec<(Uuid, bool)> = shared.iter().map(|t| (*t, exclusive.contains(t))).chain(exclusive.iter().map(|t| (*t, true))).collect();
    all.sort();
    all.dedup_by(|a, b| {
        a.0 == b.0 && {
            b.1 |= a.1;
            true
        }
    });
    for (tree, excl) in all {
        let sql = if excl {
            "select pg_advisory_xact_lock(hashtextextended('ferrum-drive-tree:' || $1::text || ':' || $2::text, 0))"
        } else {
            "select pg_advisory_xact_lock_shared(hashtextextended('ferrum-drive-tree:' || $1::text || ':' || $2::text, 0))"
        };
        sqlx::query(sql).bind(tenant).bind(tree).execute(&mut **tx).await?;
    }
    Ok(())
}

/// Lower-cased names of the live items directly in `parent` (top-level team folders when
/// `parent` is `None`) that start like `name` — the candidates a new name may clash with.
async fn names_like(tx: &mut Tx, tenant: Uuid, parent: Option<Uuid>, prefix: &str) -> Result<HashSet<String>> {
    let pattern = format!("{}%", prefix.to_lowercase().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows: Vec<String> = match parent {
        Some(p) => {
            sqlx::query_scalar(
                "select lower(name) from e_drive_folder where tenant_id = $1 and parent = $2 and not trashed and lower(name) like $3 escape '\\' \
             union all select lower(name) from e_drive_file where tenant_id = $1 and folder = $2 and not trashed and lower(name) like $3 escape '\\'",
            )
            .bind(tenant)
            .bind(p)
            .bind(&pattern)
            .fetch_all(&mut **tx)
            .await?
        }
        None => {
            sqlx::query_scalar("select lower(name) from e_drive_folder where tenant_id = $1 and is_team and not trashed and lower(name) like $2 escape '\\'")
                .bind(tenant)
                .bind(&pattern)
                .fetch_all(&mut **tx)
                .await?
        }
    };
    Ok(rows.into_iter().collect())
}

/// Whether a live item other than `except` is called `name` in `parent` (ignoring case).
pub async fn name_taken(tx: &mut Tx, tenant: Uuid, parent: Option<Uuid>, name: &str, except: Option<Uuid>) -> Result<bool> {
    let taken: bool = match parent {
        Some(p) => sqlx::query_scalar(
            "select exists (select 1 from e_drive_folder where tenant_id = $1 and parent = $2 and not trashed and lower(name) = lower($3) and id is distinct from $4) \
             or exists (select 1 from e_drive_file where tenant_id = $1 and folder = $2 and not trashed and lower(name) = lower($3) and id is distinct from $4)",
        )
        .bind(tenant)
        .bind(p)
        .bind(name)
        .bind(except)
        .fetch_one(&mut **tx)
        .await?,
        None => sqlx::query_scalar(
            "select exists (select 1 from e_drive_folder where tenant_id = $1 and is_team and not trashed and lower(name) = lower($2) and id is distinct from $3)",
        )
        .bind(tenant)
        .bind(name)
        .bind(except)
        .fetch_one(&mut **tx)
        .await?,
    };
    Ok(taken)
}

/// `name`, or the first of `name (2)`, `name (3)` … that is free in `parent` (caller holds the
/// parent's row lock).
pub async fn free_name(tx: &mut Tx, tenant: Uuid, parent: Option<Uuid>, name: &str, is_folder: bool) -> Result<String> {
    let taken = names_like(tx, tenant, parent, crate::content::stem(name, is_folder)).await?;
    if !taken.contains(&name.to_lowercase()) {
        return Ok(name.to_string());
    }
    for n in 2..100_000 {
        let candidate = crate::content::numbered(name, n, is_folder);
        if candidate.chars().count() > 255 {
            break;
        }
        if !taken.contains(&candidate.to_lowercase()) {
            return Ok(candidate);
        }
    }
    Err(Error::Conflict(format!("cannot find a free name like '{name}'")))
}

/// Refuses `name` when a live item in `parent` already has it.
pub async fn ensure_free(tx: &mut Tx, tenant: Uuid, parent: Option<Uuid>, name: &str, except: Option<Uuid>) -> Result<()> {
    if name_taken(tx, tenant, parent, name, except).await? {
        return Err(Error::Conflict(format!("an item named '{name}' already exists here")));
    }
    Ok(())
}

// ───────────────────────────── quotas ─────────────────────────────

/// Who pays for an item's bytes: a personal space or a team folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Payer {
    Space(Uuid),
    Team(Uuid),
}

const MB: i64 = 1 << 20;

/// The payer of a tree, from its top folder.
pub async fn payer(tx: &mut Tx, tenant: Uuid, top: Uuid) -> Result<Payer> {
    let team: Option<bool> =
        sqlx::query_scalar("select is_team from e_drive_folder where tenant_id = $1 and id = $2").bind(tenant).bind(top).fetch_optional(&mut **tx).await?;
    if team == Some(true) {
        return Ok(Payer::Team(top));
    }
    let space: Option<Uuid> =
        sqlx::query_scalar("select id from e_drive_space where tenant_id = $1 and root_folder = $2").bind(tenant).bind(top).fetch_optional(&mut **tx).await?;
    space.map(Payer::Space).ok_or_else(|| Error::internal(format!("drive tree {top} belongs to no space or team")))
}

/// Adds `bytes` to the payer's usage, refusing (atomically) to pass its quota; a negative amount
/// refunds. The row stays locked until commit, so concurrent uploads are counted one by one.
pub async fn charge(tx: &mut Tx, tenant: Uuid, payer: Payer, bytes: i64) -> Result<()> {
    if bytes == 0 {
        return Ok(());
    }
    let (table, extra) = match payer {
        Payer::Space(_) => ("e_drive_space", ""),
        Payer::Team(_) => ("e_drive_folder", " and is_team"),
    };
    let id = match payer {
        Payer::Space(i) | Payer::Team(i) => i,
    };
    let sql = format!(
        "update {table} set used_bytes = coalesce(used_bytes, 0) + $3 where tenant_id = $1 and id = $2{extra} \
         and ($3 < 0 or coalesce(quota_mb, 0) = 0 or coalesce(used_bytes, 0) + $3 <= quota_mb * $4) returning used_bytes"
    );
    // A refusal is explained by `room`; should space have been freed in between, charge again.
    for _ in 0..3 {
        let done: Option<i64> = sqlx::query_scalar(AssertSqlSafe(sql.clone())).bind(tenant).bind(id).bind(bytes).bind(MB).fetch_optional(&mut **tx).await?;
        if done.is_some() {
            return Ok(());
        }
        room(tx, tenant, payer, bytes).await?;
    }
    Err(Error::Retryable("storage usage is changing; try again".into()))
}

/// Refuses (without locking anything) when `bytes` more would pass the payer's quota — the
/// early check before bytes are stored; [`charge`] stays the authority at commit.
pub async fn room(tx: &mut Tx, tenant: Uuid, payer: Payer, bytes: i64) -> Result<()> {
    let (table, id) = match payer {
        Payer::Space(i) => ("e_drive_space", i),
        Payer::Team(i) => ("e_drive_folder", i),
    };
    let (used, quota): (Option<i64>, Option<i64>) =
        sqlx::query_as(AssertSqlSafe(format!("select used_bytes, quota_mb from {table} where tenant_id = $1 and id = $2")))
            .bind(tenant)
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| Error::internal("drive quota holder vanished"))?;
    let (used, quota) = (used.unwrap_or(0), quota.unwrap_or(0));
    if bytes <= 0 || quota == 0 || used + bytes <= quota * MB {
        return Ok(());
    }
    let whose = if matches!(payer, Payer::Team(_)) { "this team folder" } else { "this space" };
    Err(Error::Invalid(format!("storage quota exceeded: {whose} uses {} of {quota} MB and this needs {} more", mb(used), mb(bytes))))
}

fn mb(bytes: i64) -> String {
    let tenths = (bytes * 10 + MB / 2) / MB;
    format!("{}.{}", tenths / 10, tenths % 10)
}

/// Bytes of every version of the files in a subtree (or of one file), and of their documents'
/// images, for moving usage between payers.
pub async fn subtree_bytes(tx: &mut Tx, tenant: Uuid, item: &Item) -> Result<i64> {
    let bytes: Option<i64> = match item.kind {
        Kind::File => {
            sqlx::query_scalar("select sum(size)::bigint from e_drive_file_version where tenant_id = $1 and file = $2")
                .bind(tenant)
                .bind(item.id)
                .fetch_one(&mut **tx)
                .await?
        }
        Kind::Folder => {
            sqlx::query_scalar(
                "select sum(v.size)::bigint from e_drive_file_version v join e_drive_file f on f.tenant_id = v.tenant_id and f.id = v.file \
             where v.tenant_id = $1 and f.ancestors ? $2",
            )
            .bind(tenant)
            .bind(item.id.to_string())
            .fetch_one(&mut **tx)
            .await?
        }
    };
    Ok(bytes.unwrap_or(0) + crate::images::bytes_in(tx, tenant, item).await?)
}

// ───────────────────────────── settings and spaces ─────────────────────────────

#[derive(Debug, Clone)]
pub struct Settings {
    pub max_upload_bytes: i64,
    pub user_quota_mb: i64,
    pub team_quota_mb: i64,
    pub trash_days: i64,
    pub max_versions: i64,
    pub allow_public_links: bool,
    pub max_link_days: i64,
    pub link_password_required: bool,
}

/// The workspace's Drive settings (defaults until an administrator saves them).
pub async fn settings(tx: &mut Tx, tenant: Uuid) -> Result<Settings> {
    type R = (Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<bool>, Option<i64>, Option<bool>);
    let r: Option<R> = sqlx::query_as(
        "select max_upload_mb, user_quota_mb, team_quota_mb, trash_days, max_versions, allow_public_links, max_link_days, link_password_required \
         from e_drive_settings where tenant_id = $1 limit 1",
    )
    .bind(tenant)
    .fetch_optional(&mut **tx)
    .await?;
    let r = r.unwrap_or_default();
    Ok(Settings {
        max_upload_bytes: (r.0.unwrap_or(25).clamp(1, 1024) * MB).min(crate::site::max_file_bytes() as i64),
        user_quota_mb: r.1.unwrap_or(5120).max(0),
        team_quota_mb: r.2.unwrap_or(51200).max(0),
        trash_days: r.3.unwrap_or(30).clamp(1, 3650),
        max_versions: r.4.unwrap_or(100).max(0),
        allow_public_links: r.5.unwrap_or(true),
        max_link_days: r.6.unwrap_or(0).max(0),
        link_password_required: r.7.unwrap_or(false),
    })
}

#[derive(Debug, Clone)]
pub struct Space {
    pub id: Uuid,
    pub owner: String,
    pub root: Uuid,
}

/// The space of a person (by email), if it exists.
pub async fn space_of(tx: &mut Tx, tenant: Uuid, email: &str) -> Result<Option<Space>> {
    let row: Option<(Uuid, String, Option<Uuid>)> = sqlx::query_as("select id, owner, root_folder from e_drive_space where tenant_id = $1 and owner = $2")
        .bind(tenant)
        .bind(email.trim().to_lowercase())
        .fetch_optional(&mut **tx)
        .await?;
    Ok(row.and_then(|(id, owner, root)| root.map(|root| Space { id, owner, root })))
}

/// A space record as the action hook receives it.
pub fn space_from_doc(doc: &Doc) -> Result<Space> {
    let id = ferrum_domain::util::id(doc, "id").ok_or_else(|| Error::internal("space without id"))?;
    let root = ferrum_domain::util::id(doc, "root_folder").ok_or_else(|| Error::internal("space without a top folder"))?;
    Ok(Space { id, owner: ferrum_domain::util::s(doc, "owner").unwrap_or_default().to_string(), root })
}

/// The caller's space, created with its top folder on first use (concurrent first uses agree).
pub async fn ensure_space(k: &Kernel, ctx: &Ctx) -> Result<Space> {
    ctx.require("DriveSpace", ferrum_kernel::Action::Read)?;
    let email = ctx.email.trim().to_lowercase();
    for _ in 0..3 {
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        if let Some(s) = space_of(&mut tx, ctx.tenant, &email).await? {
            tx.commit().await?;
            return Ok(s);
        }
        let mut doc = Doc::new();
        doc.insert("owner".into(), json!(email));
        match k.insert_tx(&elevated(ctx), &mut tx, "DriveSpace", doc).await {
            Ok(_) => {
                let space = space_of(&mut tx, ctx.tenant, &email).await?.ok_or_else(|| Error::internal("space vanished"))?;
                tx.commit().await?;
                return Ok(space);
            }
            // Another request created it first.
            Err(Error::Conflict(_)) | Err(Error::Retryable(_)) => tx.rollback().await?,
            Err(e) => return Err(e),
        }
    }
    Err(Error::Retryable("drive space creation raced; try again".into()))
}

// ───────────────────────────── activity ─────────────────────────────

/// Appends to the activity log (in the caller's transaction). `ctx` without a user (system jobs,
/// public-link visitors) is logged without an actor.
pub async fn log(tx: &mut Tx, ctx: &Ctx, item: &Item, action: &str, details: Value) -> Result<()> {
    let (file, folder) = match item.kind {
        Kind::File => (Some(item.id), None),
        Kind::Folder => (None, Some(item.id)),
    };
    let actor = (!ctx.user.is_nil()).then(|| ctx.email.trim().to_lowercase());
    sqlx::query(
        "insert into e_drive_activity (tenant_id, id, file, folder, item_name, action, actor, details, created_by, updated_by) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)",
    )
    .bind(ctx.tenant)
    .bind(Uuid::now_v7())
    .bind(file)
    .bind(folder)
    .bind(item.name.chars().take(255).collect::<String>())
    .bind(action)
    .bind(actor)
    .bind(details)
    .bind((!ctx.user.is_nil()).then_some(ctx.user))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// The ids among `ids` the caller starred.
pub async fn starred(tx: &mut Tx, tenant: Uuid, email: &str, ids: &[Uuid]) -> Result<HashSet<Uuid>> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<Uuid> =
        sqlx::query_scalar("select coalesce(file, folder) from e_drive_star where tenant_id = $1 and email = $2 and (file = any($3) or folder = any($3))")
            .bind(tenant)
            .bind(email)
            .bind(ids)
            .fetch_all(&mut **tx)
            .await?;
    Ok(rows.into_iter().collect())
}

/// Items as JSON with the caller's level and stars.
pub async fn items_json(tx: &mut Tx, tenant: Uuid, g: &Grants, items: &[Item]) -> Result<Vec<Value>> {
    let ids: Vec<Uuid> = items.iter().map(|i| i.id).collect();
    let stars = starred(tx, tenant, &g.email, &ids).await?;
    Ok(items.iter().map(|i| i.json(i.level(g), stars.contains(&i.id))).collect())
}

/// The enclosing folders the caller can see, outermost first, ending with `item` itself when it
/// is a folder. Folders above the first visible one are never named.
pub async fn breadcrumbs(tx: &mut Tx, tenant: Uuid, g: &Grants, item: &Item) -> Result<Vec<Value>> {
    let mut path = item.ancestors.clone();
    if item.kind == Kind::Folder {
        path.push(item.id);
    }
    let top = path.first().copied();
    let first = (0..path.len()).find(|&i| g.level(path[i], if i == 0 { None } else { top }, &path[..i]) >= Level::View);
    let Some(first) = first else { return Ok(vec![]) };
    let visible = &path[first..];
    let names: Vec<(Uuid, String)> =
        sqlx::query_as("select id, name from e_drive_folder where tenant_id = $1 and id = any($2)").bind(tenant).bind(visible).fetch_all(&mut **tx).await?;
    Ok(visible.iter().filter_map(|id| names.iter().find(|n| n.0 == *id).map(|n| json!({"id": n.0, "name": n.1}))).collect())
}

/// An active user of the workspace, by email: `(id, full_name)`.
pub async fn user_by_email(tx: &mut Tx, tenant: Uuid, email: &str) -> Result<Option<(Uuid, String)>> {
    Ok(sqlx::query_as("select id, full_name from app_user where tenant_id = $1 and email = $2 and is_active")
        .bind(tenant)
        .bind(email.trim().to_lowercase())
        .fetch_optional(&mut **tx)
        .await?)
}

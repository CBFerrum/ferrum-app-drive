//! End-to-end Drive test against a real PostgreSQL (`FERRUM_DRIVE_TEST_DATABASE_URL`, default
//! `postgres://ferrum:ferrum@localhost:5432/ferrum_drive_test`). The database is reset first.
//!
//! A company's people use Drive the way the web app and AI agents do — through actions on their
//! own Drive Space, the signed-in Site endpoints and public links: uploads with sniffed types and
//! name clashes, folders, sharing with people and roles (inheritance, upgrades, revocation, role
//! removal, expiry), team folders with members and quotas, versions, check-out, restore, moves
//! (cycles refused, also under concurrency), copies, trash, restore and purge, public links
//! (passwords, lockout, expiry, download caps under concurrency), quotas under concurrent
//! uploads, reports — and every way a file could leak (generic records API, search, files API,
//! collaboration, audit, reports, listings, breadcrumbs, activity, shares, links) is probed for
//! someone who may not see it. Usage counters, tree paths and stored objects are checked for
//! consistency at the end.

use async_trait::async_trait;
use base64::Engine as _;
use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Ctx, Db, DbConfig, Doc, Error, HookRegistry, Kernel, KernelSettings, ListQuery, SiteRequest, SiteResponse};
use ferrum_meta::Catalog;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

fn obj(v: Value) -> Doc {
    v.as_object().cloned().unwrap()
}

fn uid(v: &Value) -> Uuid {
    v["id"].as_str().unwrap_or_else(|| panic!("no id in {v}")).parse().unwrap()
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// `len` bytes that are a PNG as far as anyone sniffing can tell.
fn png(len: usize) -> Vec<u8> {
    let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
    v.resize(len, 7);
    v
}

fn names(list: &Value) -> Vec<String> {
    list.as_array().unwrap().iter().map(|i| i["name"].as_str().unwrap().to_string()).collect()
}

fn code(e: &Error) -> &'static str {
    e.code()
}

/// The platform's object storage, in memory.
#[derive(Default)]
struct MemStore(Mutex<HashMap<String, Vec<u8>>>);

#[async_trait]
impl ferrum_kernel::files::FileStore for MemStore {
    async fn put(&self, key: &str, data: &[u8]) -> ferrum_kernel::Result<()> {
        self.0.lock().unwrap().insert(key.to_string(), data.to_vec());
        Ok(())
    }
    async fn get(&self, key: &str) -> ferrum_kernel::Result<Vec<u8>> {
        self.0.lock().unwrap().get(key).cloned().ok_or_else(|| Error::NotFound("object".into()))
    }
    async fn delete(&self, key: &str) -> ferrum_kernel::Result<()> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

/// A person using Drive.
#[derive(Clone)]
struct U {
    id: Uuid,
    email: String,
    ctx: Ctx,
    space: Uuid,
    root: Uuid,
}

struct T {
    k: Arc<Kernel>,
    tenant: Uuid,
    admin: Ctx,
}

impl T {
    async fn person(&self, email: &str, roles: &[&str]) -> (Uuid, Ctx) {
        let roles: Vec<String> = roles.iter().map(|r| r.to_string()).collect();
        let id = self.k.create_user(&self.admin, email, &email.replace("@acme.test", ""), Some("Correct-Horse-9"), &roles, false).await.expect("user");
        (id, self.k.load_ctx(self.tenant, id, None, "it".into()).await.expect("ctx"))
    }

    /// A Drive user whose space is opened through the Site (`GET /space`).
    async fn user(&self, email: &str, roles: &[&str]) -> U {
        let (id, ctx) = self.person(email, roles).await;
        let s = self.json(self.site(Some(&ctx), "GET", "/space", &[], &[], vec![]).await.expect("space"));
        U { id, email: email.into(), ctx, space: uid(&s), root: s["root_folder"].as_str().unwrap().parse().unwrap() }
    }

    async fn refresh(&self, u: &mut U) {
        self.k.invalidate_user(self.tenant, u.id);
        u.ctx = self.k.load_ctx(self.tenant, u.id, None, "it".into()).await.expect("ctx");
    }

    async fn act(&self, u: &U, action: &str, params: Value) -> ferrum_kernel::Result<Value> {
        self.k.run_action(&u.ctx, "DriveSpace", u.space, action, params).await
    }
    async fn ok(&self, u: &U, action: &str, params: Value) -> Value {
        self.act(u, action, params.clone()).await.unwrap_or_else(|e| panic!("{} {action} {params}: {e:?}", u.email))
    }
    async fn no(&self, u: &U, action: &str, params: Value) -> Error {
        match self.act(u, action, params.clone()).await {
            Ok(v) => panic!("{} {action} {params} should have been refused, got {v}", u.email),
            Err(e) => e,
        }
    }
    /// Refused exactly like an item that does not exist.
    async fn hidden(&self, u: &U, action: &str, params: Value) {
        let e = self.no(u, action, params.clone()).await;
        assert_eq!(e.to_string(), "Drive item not found", "{} {action} {params}: {e:?}", u.email);
    }

    async fn site(
        &self,
        user: Option<&Ctx>,
        method: &str,
        path: &str,
        query: &[(&str, &str)],
        headers: &[(&str, &str)],
        body: Vec<u8>,
    ) -> ferrum_kernel::Result<SiteResponse> {
        let site = self.k.hooks.site("drive").expect("drive site").clone();
        site.handle(&self.k, request(self.tenant, user, method, path, query, headers, body)).await
    }
    fn json(&self, r: SiteResponse) -> Value {
        serde_json::from_slice(&r.body).unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&r.body)))
    }

    async fn upload(&self, u: &U, folder: Uuid, name: &str, data: &[u8]) -> Value {
        self.ok(u, "upload", json!({"folder": folder, "name": name, "content_base64": b64(data)})).await
    }
    async fn folder(&self, u: &U, parent: Uuid, name: &str) -> Uuid {
        uid(&self.ok(u, "create_folder", json!({"parent": parent, "name": name})).await)
    }

    async fn scalar(&self, sql: &str, id: Option<Uuid>) -> i64 {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        let v: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string())).bind(self.tenant).bind(id).fetch_one(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        v
    }
    async fn exec(&self, sql: &str, id: Uuid) {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).bind(self.tenant).bind(id).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
    }
    async fn used(&self, space_or_team: Uuid) -> i64 {
        self.scalar(
            "select coalesce((select used_bytes from e_drive_space where tenant_id = $1 and id = $2), \
             (select used_bytes from e_drive_folder where tenant_id = $1 and id = $2), -1)",
            Some(space_or_team),
        )
        .await
    }

    /// Usage counters equal the bytes of every version in each tree; every stored object belongs
    /// to exactly one version and nothing is left unattached; every item's place in the tree
    /// agrees with its parent's.
    async fn consistent(&self) {
        let off = self
            .scalar(
                "select count(*) from (select coalesce(s.used_bytes, 0) as used, coalesce((select sum(v.size) from e_drive_file_version v \
                 join e_drive_file f on f.tenant_id = v.tenant_id and f.id = v.file where v.tenant_id = s.tenant_id and f.root = s.root_folder), 0) as stored \
                 from e_drive_space s where s.tenant_id = $1 and $2::uuid is null union all \
                 select coalesce(t.used_bytes, 0), coalesce((select sum(v.size) from e_drive_file_version v join e_drive_file f on f.tenant_id = v.tenant_id \
                 and f.id = v.file where v.tenant_id = t.tenant_id and f.root = t.id), 0) from e_drive_folder t where t.tenant_id = $1 and t.is_team) x \
                 where used <> stored",
                None,
            )
            .await;
        assert_eq!(off, 0, "usage counters match stored versions");
        let orphans = self
            .scalar(
                "select count(*) from file_object fo where fo.tenant_id = $1 and $2::uuid is null and (fo.entity is null or (fo.entity = 'DriveFile' \
                 and not exists (select 1 from e_drive_file_version v where v.tenant_id = fo.tenant_id and v.stored_file = fo.id::text)))",
                None,
            )
            .await;
        assert_eq!(orphans, 0, "no stored object without a version, none unattached");
        let missing = self
            .scalar(
                "select count(*) from e_drive_file_version v where v.tenant_id = $1 and $2::uuid is null and not exists \
                 (select 1 from file_object fo where fo.tenant_id = v.tenant_id and fo.id::text = v.stored_file and fo.entity = 'DriveFile' and fo.record_id = v.file)",
                None,
            )
            .await;
        assert_eq!(missing, 0, "every version's object exists and is attached to its file");
        let misplaced = self
            .scalar(
                "select count(*) from (select c.id from e_drive_folder c join e_drive_folder p on p.tenant_id = c.tenant_id and p.id = c.parent \
                   where c.tenant_id = $1 and (c.ancestors <> p.ancestors || jsonb_build_array(p.id::text) or c.root is distinct from coalesce(p.root, p.id) \
                   or c.owner is distinct from p.owner) \
                 union all select c.id from e_drive_file c join e_drive_folder p on p.tenant_id = c.tenant_id and p.id = c.folder \
                   where c.tenant_id = $1 and (c.ancestors <> p.ancestors || jsonb_build_array(p.id::text) or c.root is distinct from coalesce(p.root, p.id) \
                   or c.owner is distinct from p.owner)) x where $2::uuid is null",
                None,
            )
            .await;
        assert_eq!(misplaced, 0, "every item's enclosing folders, top folder and owner follow its parent");
    }
}

fn request(tenant: Uuid, user: Option<&Ctx>, method: &str, path: &str, query: &[(&str, &str)], headers: &[(&str, &str)], body: Vec<u8>) -> SiteRequest {
    SiteRequest {
        tenant,
        user: user.cloned(),
        method: method.into(),
        path: path.into(),
        query: query.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<Map<String, Value>>(),
        headers: headers.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<Map<String, Value>>(),
        body,
        client_ip: "127.0.0.1".into(),
    }
}

fn header<'a>(r: &'a SiteResponse, name: &str) -> Option<&'a str> {
    r.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

#[test]
fn drive_end_to_end() {
    // Same runtime shape as the server: unoptimized async hook chains need more than 2 MiB.
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

async fn scenario() {
    let url = std::env::var("FERRUM_DRIVE_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_drive_test".into());
    let db = Db::connect(DbConfig { url, max_connections: 40, ..Default::default() }).await.expect("connect");
    sqlx::raw_sql("drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_drive::packages().expect("app packages"));
    // The Mail app's `Communication`, as far as Drive writes it (delivery is Mail's job).
    packages.extend(
        ferrum_meta::catalog::load_embedded(&[
            ("comms", "package.yaml", "package: comms\nversion: 0.0.0\nlabel: Mail (stand-in)\ndepends: [core]\n"),
            (
                "comms",
                "entities/mail.yaml",
                "- name: Communication\n  label: Communication\n  kind: master\n  title_field: subject\n  fields:\n\
                 \x20   - {name: subject, type: data, max_length: 998}\n\
                 \x20   - {name: channel, type: select, options: [Email, SMS, Chat, Phone, Note, Meeting], default: Email, required: true}\n\
                 \x20   - {name: direction, type: select, options: [Sent, Received], default: Sent, required: true}\n\
                 \x20   - {name: recipients, type: text}\n    - {name: content, type: text}\n    - {name: text_content, type: text}\n",
            ),
        ])
        .expect("mail stand-in"),
    );
    let catalog = Catalog::from_packages(packages).expect("catalog");
    let mut hooks = HookRegistry::default();
    ferrum_domain::register(&mut hooks);
    ferrum_app_drive::register(&mut hooks);
    for source in ferrum_app_drive::reports() {
        ferrum_domain::reports::add_source(source);
    }
    let settings = KernelSettings { public_url: Some("https://erp.acme.test".into()), ..Default::default() };
    let k = Kernel::boot(db, catalog, hooks, settings, None).await.expect("boot");
    let store = Arc::new(MemStore::default());
    k.set_file_store(store.clone());
    ferrum_domain::maintenance(&k).await.expect("partitions");
    let tenant = k
        .create_tenant(NewTenant {
            slug: "acme".into(),
            name: "Acme".into(),
            admin_email: "admin@acme.test".into(),
            admin_password: "Correct-Horse-9".into(),
            admin_name: None,
            packages: vec!["drive".into(), "comms".into()],
            settings: Some(json!({"timezone": "America/New_York"})),
        })
        .await
        .expect("tenant");
    let session = k.login("acme", "admin@acme.test", "Correct-Horse-9").await.expect("login");
    let admin = k.load_ctx(tenant, session.user, Some(session.token_version), "it".into()).await.expect("ctx");
    let t = T { k: k.clone(), tenant, admin: admin.clone() };
    k.insert(
        &admin,
        "DriveSettings",
        obj(json!({"max_upload_mb": 2, "user_quota_mb": 5120, "team_quota_mb": 51200, "trash_days": 30, "max_versions": 3, "allow_public_links": true})),
    )
    .await
    .expect("settings");

    // ───────────── spaces: everyone their own, nobody else's ─────────────
    let (alice_id, alice_ctx) = t.person("alice@acme.test", &["Drive User"]).await;
    let mine = k.insert(&alice_ctx, "DriveSpace", obj(json!({}))).await.expect("alice creates her space through the generic API");
    assert_eq!(mine["owner"], json!("alice@acme.test"));
    assert_eq!(mine["quota_mb"], json!(5120));
    let mine = k.get(&alice_ctx, "DriveSpace", uid(&Value::Object(mine)), false).await.expect("her space");
    let alice = U {
        id: alice_id,
        email: "alice@acme.test".into(),
        ctx: alice_ctx,
        space: uid(&Value::Object(mine.clone())),
        root: mine["root_folder"].as_str().unwrap().parse().unwrap(),
    };
    let bob = t.user("bob@acme.test", &["Drive User"]).await;
    let mut carol = t.user("carol@acme.test", &["Drive User", "Accounts Manager"]).await;
    let frank = t.user("frank@acme.test", &["Drive User"]).await;
    let erin = t.user("erin@acme.test", &["Drive Administrator"]).await;
    let (_, dave) = t.person("dave@acme.test", &["Accounts Manager"]).await;
    let again = t.json(t.site(Some(&bob.ctx), "GET", "/space", &[], &[], vec![]).await.unwrap());
    assert_eq!(uid(&again), bob.space, "opening Drive again finds the same space");
    let e = k.insert(&bob.ctx, "DriveSpace", obj(json!({"owner": "alice@acme.test"}))).await.expect_err("a space for someone else");
    assert_eq!(code(&e), "forbidden");
    assert_eq!(code(&k.insert(&bob.ctx, "DriveSpace", obj(json!({}))).await.expect_err("a second space")), "conflict");
    assert_eq!(code(&t.site(Some(&dave), "GET", "/space", &[], &[], vec![]).await.expect_err("no Drive role")), "forbidden");
    assert_eq!(code(&k.insert(&dave, "DriveSpace", obj(json!({}))).await.expect_err("no Drive role")), "forbidden");
    let spaces = k.list(&bob.ctx, "DriveSpace", &ListQuery::default()).await.unwrap();
    assert_eq!(spaces.rows.len(), 1, "a Drive user lists only their own space");
    assert_eq!(code(&k.get(&bob.ctx, "DriveSpace", alice.space, false).await.expect_err("alice's space")), "not_found");
    let e = k.run_action(&bob.ctx, "DriveSpace", alice.space, "list_folder", json!({})).await.expect_err("acting on alice's space");
    assert_eq!(code(&e), "not_found");
    assert_eq!(code(&k.delete(&admin, "DriveSpace", bob.space, None).await.expect_err("spaces are kept")), "forbidden");

    // ───────────── uploads: types from bytes, names, limits ─────────────
    let report = t.upload(&alice, alice.root, "report.pdf", &png(1000)).await;
    assert_eq!((report["content_type"].as_str(), report["file_type"].as_str(), report["version"].as_i64()), (Some("image/png"), Some("Image"), Some(1)));
    assert_eq!(report["size"], json!(1000));
    assert_eq!(report["permission"], json!("Manage"));
    let report_id = uid(&report);
    let second = t.upload(&alice, alice.root, "report.pdf", b"%PDF-1.7 real pdf").await;
    assert_eq!(second["name"], json!("report (2).pdf"), "keep both: the new file is numbered");
    assert_eq!(second["content_type"], json!("application/pdf"));
    let shouting = t.upload(&alice, alice.root, "REPORT.PDF", b"%PDF-1.7 again").await;
    assert_eq!(shouting["name"], json!("REPORT (3).PDF"), "names clash ignoring case");
    let e = t.no(&alice, "upload", json!({"name": "Report.pdf", "text": "x", "on_conflict": "fail"})).await;
    assert_eq!(code(&e), "conflict");
    let replaced = t.ok(&alice, "upload", json!({"name": "report.pdf", "content_base64": b64(&png(1200)), "on_conflict": "replace"})).await;
    assert_eq!((uid(&replaced), replaced["version"].as_i64(), replaced["size"].as_i64()), (report_id, Some(2), Some(1200)), "replace adds a version");
    let notes = t.ok(&alice, "upload", json!({"name": "notes.md", "text": "# Plan\nship it"})).await;
    assert_eq!(notes["content_type"], json!("text/markdown"));
    let disguised = t.upload(&alice, alice.root, "cute.png", b"<!DOCTYPE html><script>alert(document.cookie)</script>").await;
    assert_eq!(disguised["content_type"], json!("text/html"));
    for bad in ["a/b.txt", "..", "  "] {
        assert_eq!(code(&t.no(&alice, "upload", json!({"name": bad, "text": "x"})).await), "validation_failed", "{bad:?}");
    }
    let objects_before = store.0.lock().unwrap().len();
    let big = vec![b'a'; (2 << 20) + 1];
    let e = t.site(Some(&alice.ctx), "POST", "/upload", &[("name", "big.txt")], &[], big.clone()).await.expect_err("over the upload limit");
    assert_eq!(code(&e), "validation_failed");
    assert_eq!(store.0.lock().unwrap().len(), objects_before, "a refused upload never reaches storage");
    // Raw-body uploads and downloads through the Site, with safe headers.
    let photo = t.json(t.site(Some(&alice.ctx), "POST", "/upload", &[("name", "photo.jpg")], &[], b"\xff\xd8\xff\xe0 a jpeg".to_vec()).await.unwrap());
    let r = t.site(Some(&alice.ctx), "GET", &format!("/files/{}/content", uid(&photo)), &[("inline", "1")], &[], vec![]).await.unwrap();
    assert_eq!((r.content_type.as_str(), &r.body[..]), ("image/jpeg", &b"\xff\xd8\xff\xe0 a jpeg"[..]));
    assert!(header(&r, "content-disposition").unwrap().starts_with("inline; filename=\"photo.jpg\""));
    assert_eq!(header(&r, "x-content-type-options"), Some("nosniff"));
    assert!(header(&r, "content-security-policy").unwrap().contains("sandbox"));
    let r = t.site(Some(&alice.ctx), "GET", &format!("/files/{}/content", uid(&disguised)), &[("inline", "1")], &[], vec![]).await.unwrap();
    assert_eq!(r.content_type, "application/octet-stream", "markup is never served as a page");
    assert!(header(&r, "content-disposition").unwrap().starts_with("attachment;"));
    let r = t.site(Some(&alice.ctx), "GET", &format!("/files/{}/content", uid(&notes)), &[("inline", "1")], &[], vec![]).await.unwrap();
    assert!(header(&r, "content-disposition").unwrap().starts_with("attachment;"), "only images and PDFs show inline");
    let d = t.ok(&alice, "download", json!({"file": uid(&notes)})).await;
    assert_eq!(d["text"], json!("# Plan\nship it"));
    assert_eq!(base64::engine::general_purpose::STANDARD.decode(d["content_base64"].as_str().unwrap()).unwrap(), b"# Plan\nship it");

    // ───────────── folders, listing, paging, breadcrumbs ─────────────
    let projects = t.folder(&alice, alice.root, "Projects").await;
    let q3 = t.folder(&alice, projects, "Q3").await;
    let drafts = t.folder(&alice, q3, "Drafts").await;
    let secret = t.folder(&alice, alice.root, "Secret").await;
    let salary = uid(&t.upload(&alice, secret, "salary.xlsx", b"PK\x03\x04 salaries").await);
    let dup = t.ok(&alice, "create_folder", json!({"name": "projects"})).await;
    assert_eq!(dup["name"], json!("projects (2)"));
    let plan = uid(&t.upload(&alice, q3, "plan.txt", b"one").await);
    t.upload(&alice, drafts, "draft.txt", b"draft").await;
    let root = t.ok(&alice, "list_folder", json!({})).await;
    assert_eq!(root["folders"], json!(3));
    assert_eq!(root["files"], json!(6));
    assert_eq!(names(&root["items"])[..3], ["Projects", "projects (2)", "Secret"], "folders first, by name");
    let page = t.ok(&alice, "list_folder", json!({"limit": 2, "offset": 2})).await;
    assert_eq!(names(&page["items"]), ["Secret", "cute.png"], "pages run from folders into files");
    let by_size = t.ok(&alice, "list_folder", json!({"sort": "size", "order": "desc", "limit": 4})).await;
    assert_eq!(names(&by_size["items"])[3], "report.pdf", "biggest file first after the folders");
    let listing = t.ok(&alice, "list_folder", json!({"folder": drafts})).await;
    assert_eq!(names(&listing["breadcrumbs"]), ["My Folders", "Projects", "Q3", "Drafts"]);
    assert_eq!(code(&t.no(&alice, "list_folder", json!({"sort": "colour"})).await), "validation_failed");

    // ───────────── sharing: inheritance down the tree, never up or sideways ─────────────
    let s = t.ok(&alice, "share", json!({"item": projects, "email": "bob@acme.test", "permission": "View"})).await;
    assert_eq!(s["permission"], json!("View"));
    let bell: i64 =
        t.scalar("select count(*) from notification where tenant_id = $1 and user_id = $2 and title like '%shared \"Projects\"%'", Some(bob.id)).await;
    assert_eq!(bell, 1, "bob is told in the app");
    let mails: Vec<(String, String, String)> = {
        let mut tx = k.db.tenant_tx(tenant).await.unwrap();
        let m = sqlx::query_as("select recipients, subject, content from e_communication where tenant_id = $1 order by created_at")
            .bind(tenant)
            .fetch_all(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        m
    };
    assert_eq!(mails.len(), 1, "and by mail, the workspace having the Mail app");
    assert_eq!((mails[0].0.as_str(), mails[0].1.as_str()), ("bob@acme.test", "alice shared a folder with you"));
    assert!(!mails[0].2.contains("Projects"), "mail never names the item (Mail's managers read every message): {}", mails[0].2);
    let in_drafts = t.ok(&bob, "list_folder", json!({"folder": drafts})).await;
    assert_eq!(names(&in_drafts["items"]), ["draft.txt"]);
    assert_eq!(in_drafts["folder"]["permission"], json!("View"));
    assert_eq!(names(&in_drafts["breadcrumbs"]), ["Projects", "Q3", "Drafts"], "breadcrumbs stop at what bob may see");
    let got = t.ok(&bob, "download", json!({"file": plan})).await;
    assert_eq!(got["text"], json!("one"));
    assert_eq!(code(&t.no(&bob, "upload", json!({"folder": q3, "name": "x.txt", "text": "x"})).await), "forbidden", "View cannot upload");
    assert_eq!(code(&t.no(&bob, "rename", json!({"item": plan, "name": "mine.txt"})).await), "forbidden");
    assert_eq!(code(&t.no(&bob, "share", json!({"item": q3, "email": "frank@acme.test"})).await), "forbidden");
    // Everything outside the shared folder answers as if it did not exist — through every path.
    for (action, params) in [
        ("list_folder", json!({"folder": alice.root})),
        ("list_folder", json!({"folder": secret})),
        ("item_info", json!({"item": salary})),
        ("item_info", json!({"item": Uuid::now_v7()})),
        ("download", json!({"file": salary})),
        ("list_versions", json!({"file": salary})),
        ("list_shares", json!({"item": salary})),
        ("list_links", json!({"item": salary})),
        ("create_link", json!({"item": salary})),
        ("activity", json!({"item": secret})),
        ("list_comments", json!({"file": salary})),
        ("star", json!({"item": salary})),
        ("copy", json!({"item": salary, "to": bob.root})),
        ("move", json!({"item": salary, "to": bob.root})),
        ("trash", json!({"item": salary})),
        ("rename", json!({"item": secret, "name": "Mine"})),
        ("share", json!({"item": salary, "email": "bob@acme.test"})),
        ("upload_version", json!({"file": salary, "text": "overwrite"})),
        ("check_out", json!({"file": salary})),
        ("create_folder", json!({"parent": secret, "name": "inside"})),
        ("upload", json!({"folder": secret, "name": "planted.txt", "text": "x"})),
    ] {
        t.hidden(&bob, action, params).await;
    }
    let e = t.site(Some(&bob.ctx), "GET", &format!("/files/{salary}/content"), &[], &[], vec![]).await.expect_err("download through the Site");
    assert_eq!(e.to_string(), "Drive item not found");
    let e = t.site(Some(&bob.ctx), "GET", "/item_info", &[("item", &salary.to_string())], &[], vec![]).await.expect_err("read action through the Site");
    assert_eq!(e.to_string(), "Drive item not found");
    let found = t.ok(&bob, "search", json!({"query": "a"})).await;
    let found_names = names(&found["items"]);
    assert!(found_names.contains(&"draft.txt".to_string()) && found_names.contains(&"plan.txt".to_string()), "{found_names:?}");
    assert!(!found_names.iter().any(|n| n.contains("salary") || n.contains("report") || n == "Secret"), "search never reaches past the share: {found_names:?}");
    assert_eq!(found["items"][found_names.iter().position(|n| n == "draft.txt").unwrap()]["path"], json!("Projects / Q3 / Drafts"));
    let found = t.json(t.site(Some(&bob.ctx), "GET", "/search", &[("query", "salary")], &[], vec![]).await.unwrap());
    assert_eq!(found["items"], json!([]));
    let mine_only = t.ok(&bob, "shared_with_me", json!({})).await;
    assert_eq!(names(&mine_only["items"]), ["Projects"]);
    assert_eq!(mine_only["items"][0]["shared_by"], json!("alice@acme.test"));
    // Activity of a shared folder covers what is inside it, never its surroundings.
    let act = t.ok(&bob, "activity", json!({"item": projects})).await;
    let inside: Vec<Value> = [json!(projects), json!(q3), json!(drafts), json!(plan)].to_vec();
    for a in act["activity"].as_array().unwrap() {
        let item = if a["file"].is_null() { a["folder"].clone() } else { a["file"].clone() };
        assert!(inside.contains(&item) || a["item_name"] == json!("draft.txt"), "activity leaks {a}");
    }
    // Shares of folders bob cannot see are not his to know.
    t.ok(&alice, "share", json!({"item": alice.root, "email": "frank@acme.test", "permission": "View"})).await;
    let who = t.ok(&bob, "list_shares", json!({"item": drafts})).await;
    let shared: Vec<&str> = who["shares"].as_array().unwrap().iter().map(|s| s["email"].as_str().unwrap()).collect();
    assert_eq!(shared, ["bob@acme.test"], "the share of alice's top folder stays hidden from bob");
    assert_eq!(who["shares"][0]["inherited_from"], json!(projects));
    let who = t.ok(&alice, "list_shares", json!({"item": drafts})).await;
    assert_eq!(who["shares"].as_array().unwrap().len(), 2);
    let frank_root = t.ok(&frank, "list_folder", json!({"folder": alice.root})).await;
    assert_eq!(frank_root["folder"]["permission"], json!("View"));
    t.ok(&alice, "unshare", json!({"item": alice.root, "email": "frank@acme.test"})).await;
    t.hidden(&frank, "list_folder", json!({"folder": alice.root})).await;

    // Upgrading the share takes effect at once.
    t.ok(&alice, "share", json!({"item": projects, "email": "bob@acme.test", "permission": "Edit"})).await;
    let bobs = t.ok(&bob, "upload", json!({"folder": q3, "name": "bob.txt", "text": "from bob"})).await;
    assert_eq!(bobs["owner"], json!("alice@acme.test"), "items in alice's folders are hers, charged to her");
    assert_eq!(bobs["permission"], json!("Edit"));
    t.ok(&bob, "star", json!({"item": q3})).await;
    assert_eq!(names(&t.ok(&bob, "starred", json!({})).await["items"]), ["Q3"]);

    // A role share: everyone holding the role, until the role is taken away.
    t.ok(&alice, "share", json!({"item": q3, "role": "Accounts Manager", "permission": "Comment"})).await;
    let c = t.ok(&carol, "add_comment", json!({"file": plan, "body": "Looks good"})).await;
    assert_eq!(c["author"], json!("carol@acme.test"));
    assert_eq!(code(&t.no(&carol, "upload_version", json!({"file": plan, "text": "nope"})).await), "forbidden", "Comment cannot edit");
    t.hidden(&carol, "list_folder", json!({"folder": projects})).await;
    assert_eq!(code(&t.no(&bob, "delete_comment", json!({"comment": uid(&c)})).await), "forbidden", "Edit is not enough to delete others' comments");
    let e = t.no(&carol, "share", json!({"item": q3, "role": "Nonexistent"})).await;
    assert_eq!(code(&e), "forbidden");
    assert_eq!(code(&t.no(&alice, "share", json!({"item": q3, "role": "No Such Role"})).await), "validation_failed");
    let gone = k.create_user(&admin, "gone@acme.test", "Gone", Some("Correct-Horse-9"), &[], false).await.unwrap();
    k.set_user_active(&admin, gone, false).await.unwrap();
    assert_eq!(code(&t.no(&alice, "share", json!({"item": q3, "email": "gone@acme.test"})).await), "validation_failed", "a former colleague is no guest");
    assert_eq!(code(&t.no(&alice, "share", json!({"item": q3, "email": "alice@acme.test"})).await), "validation_failed");
    k.set_user_roles(&admin, carol.id, &["Drive User".to_string()]).await.unwrap();
    t.refresh(&mut carol).await;
    t.hidden(&carol, "list_folder", json!({"folder": q3})).await;
    t.hidden(&carol, "list_comments", json!({"file": plan})).await;
    assert_eq!(t.ok(&carol, "shared_with_me", json!({})).await["items"], json!([]));
    k.set_user_roles(&admin, carol.id, &["Drive User".to_string(), "Accounts Manager".to_string()]).await.unwrap();
    t.refresh(&mut carol).await;
    assert_eq!(t.ok(&carol, "list_comments", json!({"file": plan})).await["comments"][0]["body"], json!("Looks good"));

    // Expiry: a share is worth nothing the moment it expires, and upkeep clears it.
    assert_eq!(code(&t.no(&alice, "share", json!({"item": drafts, "email": "frank@acme.test", "expires_at": "2020-01-01"})).await), "validation_failed");
    let timed = t.ok(&alice, "share", json!({"item": drafts, "email": "frank@acme.test", "permission": "Edit", "expires_at": "2099-12-31"})).await;
    assert_eq!(timed["expires_at"], json!("2100-01-01T05:00:00Z"), "a date means the end of that day where the workspace is");
    t.ok(&frank, "list_folder", json!({"folder": drafts})).await;
    t.exec("update e_drive_share set expires_at = now() - interval '1 minute' where tenant_id = $1 and id = $2", uid(&timed)).await;
    t.hidden(&frank, "list_folder", json!({"folder": drafts})).await;
    t.hidden(&frank, "download", json!({"file": plan})).await;
    assert_eq!(t.ok(&frank, "search", json!({"query": "draft"})).await["items"], json!([]));
    ferrum_app_drive::maintenance(&k).await.expect("upkeep");
    assert_eq!(t.scalar("select count(*) from e_drive_share where tenant_id = $1 and id = $2", Some(uid(&timed))).await, 0);
    let expired = t.scalar("select count(*) from e_drive_activity where tenant_id = $1 and folder = $2 and action = 'Share Expired'", Some(drafts)).await;
    assert_eq!(expired, 1);

    // ───────────── the generic records API, files API, collaboration, audit, reports: closed ─────────────
    for entity in ["DriveFolder", "DriveFile", "DriveFileVersion", "DriveShare", "DriveLink", "DriveActivity", "DriveComment", "DriveStar"] {
        let q = ListQuery { search: Some("plan".into()), ..Default::default() };
        assert_eq!(code(&k.list(&bob.ctx, entity, &q).await.expect_err(entity)), "forbidden", "{entity}");
        assert_eq!(code(&k.list(&dave, entity, &ListQuery::default()).await.expect_err(entity)), "forbidden", "{entity}");
    }
    assert_eq!(code(&k.get(&bob.ctx, "DriveFile", plan, true).await.expect_err("get")), "forbidden");
    assert_eq!(code(&k.audit_trail(&bob.ctx, "DriveFile", plan).await.expect_err("audit")), "forbidden");
    assert_eq!(code(&k.comments(&bob.ctx, "DriveFile", plan).await.expect_err("comments")), "forbidden");
    assert_eq!(code(&k.attachments(&bob.ctx, "DriveFile", plan).await.expect_err("attachments")), "forbidden");
    assert_eq!(code(&k.tags(&bob.ctx, "DriveFile", plan).await.expect_err("tags")), "forbidden");
    assert!(k.set_tags(&bob.ctx, "DriveFile", plan, &["mine".to_string()]).await.is_err());
    let object: Uuid = {
        let mut tx = k.db.tenant_tx(tenant).await.unwrap();
        let o: String = sqlx::query_scalar("select stored_file from e_drive_file_version where tenant_id = $1 and file = $2")
            .bind(tenant)
            .bind(plan)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        o.parse().unwrap()
    };
    assert!(k.read_file(&bob.ctx, object).await.is_err(), "the platform's file download applies Drive File's rules");
    assert!(k.read_file(&alice.ctx, object).await.is_err(), "even for the owner: Drive serves its own files");
    assert!(k.delete_file(&alice.ctx, object).await.is_err(), "nobody deletes a version's bytes behind Drive's back");
    assert!(k.read_file(&admin, object).await.is_ok(), "administrators read everything");
    let e = k.insert(&admin, "DriveFile", obj(json!({"name": "forged.txt", "folder": alice.root}))).await.expect_err("direct write");
    assert_eq!(code(&e), "forbidden");
    assert_eq!(code(&k.update(&admin, "DriveFile", plan, obj(json!({"name": "forged.txt"})), None).await.expect_err("direct edit")), "forbidden");
    assert_eq!(code(&k.delete(&admin, "DriveFolder", q3, None).await.expect_err("direct delete")), "forbidden");
    let none: HashMap<String, String> = HashMap::new();
    assert_eq!(code(&ferrum_domain::reports::run(&k, &bob.ctx, "drive_largest_files", &none).await.expect_err("reports")), "forbidden");
    let all_files = k.list(&erin.ctx, "DriveFile", &ListQuery { limit: Some(500), ..Default::default() }).await.unwrap();
    assert!(all_files.rows.len() >= 9, "Drive administrators read everything");
    let erin_sees = t.ok(&erin, "list_folder", json!({"folder": secret})).await;
    assert_eq!(names(&erin_sees["items"]), ["salary.xlsx"]);

    // ───────────── team folders ─────────────
    assert_eq!(code(&t.no(&alice, "create_team_folder", json!({"name": "Engineering"})).await), "forbidden");
    let team = t
        .ok(
            &erin,
            "create_team_folder",
            json!({"name": "Engineering", "quota_mb": 1, "members": [
                {"member": "alice@acme.test", "role": "Manager"}, {"member": "bob@acme.test", "role": "Editor"}, {"member": "frank@acme.test", "role": "Viewer"}]}),
        )
        .await;
    let eng = uid(&team["folder"]);
    let invited =
        t.scalar("select count(*) from e_communication where tenant_id = $1 and subject = 'erin added you to a team folder' and $2::uuid is null", None).await;
    assert_eq!(invited, 3, "each new member is told");
    assert_eq!(code(&t.no(&erin, "create_team_folder", json!({"name": "engineering"})).await), "conflict");
    let e = t.no(&erin, "create_team_folder", json!({"name": "Ops", "members": [{"member": "ghost@acme.test"}]})).await;
    assert_eq!(code(&e), "validation_failed");
    let spec = t.upload(&bob, eng, "spec.txt", &vec![b's'; 400_000]).await;
    assert_eq!(spec["owner"], Value::Null);
    assert_eq!(spec["team"], json!(eng));
    assert_eq!(t.used(eng).await, 400_000, "team files count against the team folder");
    assert_eq!(t.used(bob.space).await, 0, "not against the uploader");
    assert_eq!(code(&t.no(&frank, "upload", json!({"folder": eng, "name": "f.txt", "text": "x"})).await), "forbidden", "Viewers only read");
    assert_eq!(t.ok(&frank, "download", json!({"file": uid(&spec)})).await["size"], json!(400_000));
    let e = t.no(&bob, "upload", json!({"folder": eng, "name": "big.bin", "content_base64": b64(&vec![0u8; 700_000])})).await;
    assert!(e.to_string().contains("storage quota exceeded: this team folder uses 0.4 of 1 MB"), "{e}");
    assert_eq!(code(&t.no(&alice, "set_team_quota", json!({"folder": eng, "quota_mb": 100})).await), "forbidden", "quotas are for administrators");
    t.ok(&erin, "set_team_quota", json!({"folder": eng, "quota_mb": 10})).await;
    t.ok(&alice, "add_team_member", json!({"folder": eng, "member": "carol@acme.test", "role": "Commenter"})).await;
    t.ok(&carol, "add_comment", json!({"file": uid(&spec), "body": "Which version?"})).await;
    t.ok(&alice, "remove_team_member", json!({"folder": eng, "member": "frank@acme.test"})).await;
    t.hidden(&frank, "download", json!({"file": uid(&spec)})).await;
    assert_eq!(code(&t.no(&bob, "add_team_member", json!({"folder": eng, "member": "frank@acme.test"})).await), "forbidden", "Editors cannot manage members");
    assert_eq!(code(&t.no(&alice, "trash", json!({"item": eng})).await), "forbidden", "only administrators trash team folders");
    let usage = t.ok(&bob, "usage", json!({})).await;
    assert_eq!(usage["teams"][0]["name"], json!("Engineering"));
    assert_eq!(usage["teams"][0]["permission"], json!("Edit"));
    assert_eq!(usage["teams"][0]["used_bytes"], json!(400_000));
    let who = t.ok(&carol, "list_shares", json!({"item": uid(&spec)})).await;
    assert_eq!(who["team"]["members"].as_array().unwrap().len(), 3);

    // ───────────── versions, restore, pruning, check-out ─────────────
    let used0 = t.used(alice.space).await;
    t.ok(&alice, "upload_version", json!({"file": plan, "text": "two"})).await;
    t.ok(&alice, "upload_version", json!({"file": plan, "text": "three", "comment": "final"})).await;
    let v = t.ok(&alice, "list_versions", json!({"file": plan})).await;
    let nos: Vec<i64> = v["versions"].as_array().unwrap().iter().map(|x| x["version"].as_i64().unwrap()).collect();
    assert_eq!(nos, [3, 2, 1]);
    assert_eq!(v["versions"][0]["comment"], json!("final"));
    assert_eq!(t.used(alice.space).await, used0 + 3 + 5);
    let restored = t.ok(&alice, "restore_version", json!({"file": plan, "version": 1})).await;
    assert_eq!(restored["version"], json!(4));
    assert_eq!(t.ok(&alice, "download", json!({"file": plan})).await["text"], json!("one"));
    let v = t.ok(&alice, "list_versions", json!({"file": plan})).await;
    let nos: Vec<i64> = v["versions"].as_array().unwrap().iter().map(|x| x["version"].as_i64().unwrap()).collect();
    assert_eq!(nos, [4, 3, 2], "three versions are kept: the oldest went");
    assert_eq!(v["versions"][0]["comment"], json!("Restored from version 1"));
    assert_eq!(t.used(alice.space).await, used0 + 3 + 5 + 3 - 3, "the pruned version is refunded");
    let r = t.site(Some(&alice.ctx), "GET", &format!("/files/{plan}/content"), &[("version", "2")], &[], vec![]).await.unwrap();
    assert_eq!(r.body, b"two");
    assert_eq!(code(&t.no(&alice, "download", json!({"file": plan, "version": 1})).await), "not_found");
    // Check-out: bob reserves the file; nobody else changes it until he checks it in.
    let co = t.ok(&bob, "check_out", json!({"file": plan})).await;
    assert_eq!(co["locked_by"], json!("bob@acme.test"));
    let e = t.no(&alice, "upload_version", json!({"file": plan, "text": "alice's edit"})).await;
    assert_eq!(code(&e), "conflict");
    assert!(e.to_string().contains("checked out by bob@acme.test"));
    assert_eq!(code(&t.no(&alice, "rename", json!({"item": plan, "name": "p.txt"})).await), "conflict");
    assert_eq!(code(&t.no(&alice, "trash", json!({"item": plan})).await), "conflict");
    let r = t
        .site(Some(&bob.ctx), "POST", &format!("/files/{plan}/versions"), &[("check_in", "1"), ("comment", "bob's take")], &[], b"bob's version".to_vec())
        .await
        .unwrap();
    let checked_in = t.json(r);
    assert_eq!((checked_in["version"].as_i64(), &checked_in["locked_by"]), (Some(5), &Value::Null));
    t.ok(&bob, "check_out", json!({"file": plan})).await;
    assert_eq!(code(&t.no(&alice, "check_in", json!({"file": plan})).await), "conflict", "only the holder checks in");
    let forced = t.ok(&alice, "check_in", json!({"file": plan, "force": true})).await;
    assert_eq!(forced["locked_by"], Value::Null);
    let log = t.ok(&alice, "activity", json!({"item": plan})).await;
    let actions: Vec<&str> = log["activity"].as_array().unwrap().iter().map(|a| a["action"].as_str().unwrap()).collect();
    assert_eq!(&actions[..3], ["Check In", "Check Out", "Check In"]);
    assert_eq!(log["activity"][0]["details"]["forced_from"], json!("bob@acme.test"));

    // ───────────── moves: cycles refused, inheritance follows the place, bytes follow the payer ─────────────
    let e = t.no(&alice, "move", json!({"item": projects, "to": drafts})).await;
    assert!(e.to_string().contains("cannot be moved into itself"), "{e}");
    assert_eq!(code(&t.no(&alice, "move", json!({"item": projects, "to": projects})).await), "invalid");
    assert_eq!(code(&t.no(&alice, "move", json!({"item": alice.root, "to": projects})).await), "invalid");
    t.upload(&alice, alice.root, "plan.txt", b"another plan").await;
    assert_eq!(code(&t.no(&alice, "move", json!({"item": plan, "to": alice.root})).await), "conflict", "a taken name is refused on move");
    let moved = t.ok(&alice, "move", json!({"item": q3, "to": alice.root})).await;
    assert_eq!(moved["parent"], json!(alice.root));
    assert_eq!(names(&t.ok(&alice, "list_folder", json!({"folder": drafts})).await["breadcrumbs"]), ["My Folders", "Q3", "Drafts"]);
    t.hidden(&bob, "list_folder", json!({"folder": q3})).await;
    t.hidden(&bob, "download", json!({"file": plan})).await;
    assert_eq!(t.ok(&bob, "starred", json!({})).await["items"], json!([]), "a star does not keep access");
    let recent: Vec<String> = names(&t.ok(&bob, "recent", json!({})).await["items"]);
    assert!(!recent.contains(&"plan.txt".to_string()), "nor does having worked on it: {recent:?}");
    t.ok(&carol, "list_folder", json!({"folder": drafts})).await; // the role share on Q3 moved with it
    t.consistent().await;
    let (alice_before, team_before) = (t.used(alice.space).await, t.used(eng).await);
    let plan_bytes = t.scalar("select coalesce(sum(size), 0)::bigint from e_drive_file_version where tenant_id = $1 and file = $2", Some(plan)).await;
    let into_team = t.ok(&alice, "move", json!({"item": plan, "to": eng})).await;
    assert_eq!((&into_team["owner"], &into_team["team"]), (&Value::Null, &json!(eng)));
    assert_eq!(t.used(alice.space).await, alice_before - plan_bytes);
    assert_eq!(t.used(eng).await, team_before + plan_bytes);
    let q3_bytes = t.scalar("select coalesce(sum(v.size), 0)::bigint from e_drive_file_version v join e_drive_file f on f.id = v.file where v.tenant_id = $1 and f.ancestors ? $2::text", Some(q3)).await;
    t.ok(&alice, "move", json!({"item": q3, "to": eng})).await;
    assert_eq!(t.used(eng).await, team_before + plan_bytes + q3_bytes, "a folder moves with every version inside it");
    t.consistent().await;
    t.ok(&alice, "move", json!({"item": q3, "to": alice.root})).await;
    t.consistent().await;
    // Two people moving two folders into each other at once: one wins, the other is refused.
    let race = t.folder(&alice, alice.root, "Race").await;
    let (a, b) = (t.folder(&alice, race, "A").await, t.folder(&alice, race, "B").await);
    t.ok(&alice, "share", json!({"item": race, "email": "bob@acme.test", "permission": "Edit"})).await;
    let (k1, k2) = (k.clone(), k.clone());
    let (u1, u2) = (alice.clone(), bob.clone());
    let one = tokio::spawn(async move { k1.run_action(&u1.ctx, "DriveSpace", u1.space, "move", json!({"item": a, "to": b})).await });
    let two = tokio::spawn(async move { k2.run_action(&u2.ctx, "DriveSpace", u2.space, "move", json!({"item": b, "to": a})).await });
    let (one, two) = (one.await.unwrap(), two.await.unwrap());
    assert!(one.is_ok() != two.is_ok(), "exactly one of the crossing moves succeeds: {one:?} {two:?}");
    let parents = t.scalar("select count(*) from e_drive_folder where tenant_id = $1 and parent = $2", Some(race)).await;
    assert_eq!(parents, 1, "one folder is inside the other, no cycle");
    let e = t.no(&bob, "move", json!({"item": a, "to": bob.root})).await;
    assert_eq!(code(&e), "forbidden", "an editor cannot carry alice's folder off into his own space");
    t.ok(&bob, "copy", json!({"item": a, "to": bob.root})).await; // a copy is his to keep
    t.consistent().await;

    // ───────────── copies ─────────────
    let used_before = t.used(alice.space).await;
    let copy = t.ok(&alice, "copy", json!({"item": q3, "to": alice.root})).await;
    assert_eq!(copy["name"], json!("Q3 (2)"));
    let copied = t.ok(&alice, "list_folder", json!({"folder": uid(&copy)})).await;
    assert_eq!(names(&copied["items"]), ["Drafts", "bob.txt"]);
    let copied_drafts = uid(&copied["items"][0]);
    assert_eq!(names(&t.ok(&alice, "list_folder", json!({"folder": copied_drafts})).await["items"]), ["draft.txt"]);
    assert_eq!(t.used(alice.space).await, used_before + 8 + 5, "copies are charged (current versions only)");
    assert_eq!(code(&t.no(&alice, "copy", json!({"item": q3, "to": drafts})).await), "invalid");
    let copied_file = t.ok(&alice, "copy", json!({"item": uid(&notes), "to": projects, "name": "notes copy.md"})).await;
    assert_eq!(t.ok(&alice, "download", json!({"file": uid(&copied_file)})).await["text"], json!("# Plan\nship it"));
    t.consistent().await;

    // ───────────── trash, restore, delete for good, purge ─────────────
    let gone = t.ok(&alice, "trash", json!({"item": projects})).await;
    assert_eq!(gone["trashed"], json!(true));
    t.hidden(&bob, "list_folder", json!({"folder": projects})).await;
    t.hidden(&alice, "list_folder", json!({"folder": projects})).await;
    t.hidden(&alice, "download", json!({"file": uid(&copied_file)})).await;
    assert!(!names(&t.ok(&alice, "search", json!({"query": "notes copy"})).await["items"]).contains(&"notes copy.md".to_string()));
    let trash = t.ok(&alice, "list_trash", json!({})).await;
    assert_eq!(names(&trash["items"]), ["Projects"], "only what was trashed itself is listed");
    assert_eq!(code(&t.no(&alice, "trash", json!({"item": alice.root})).await), "invalid");
    assert_eq!(code(&t.no(&alice, "restore", json!({"item": uid(&copied_file)})).await), "not_found", "not trashed itself");
    t.folder(&alice, alice.root, "Projects").await; // the name is free again
    let back = t.ok(&alice, "restore", json!({"item": projects})).await;
    assert_eq!(back["name"], json!("Projects (3)"), "a name taken meanwhile is numbered (\"projects (2)\" exists too)");
    t.ok(&bob, "list_folder", json!({"folder": projects})).await; // shares survive the trash
    // Delete for good: bytes, versions, shares and links go, the quota is refunded.
    let doomed = t.upload(&alice, alice.root, "doomed.bin", &vec![9u8; 5000]).await;
    let doomed_id = uid(&doomed);
    t.ok(&alice, "upload_version", json!({"file": doomed_id, "content_base64": b64(&vec![8u8; 6000])})).await;
    t.ok(&alice, "share", json!({"item": doomed_id, "email": "bob@acme.test"})).await;
    t.ok(&alice, "create_link", json!({"item": doomed_id, "access": "Download"})).await;
    let before = t.used(alice.space).await;
    let objects_of = |f: Uuid| {
        let t = &t;
        async move { t.scalar("select count(*) from file_object where tenant_id = $1 and entity = 'DriveFile' and record_id = $2", Some(f)).await }
    };
    assert_eq!(objects_of(doomed_id).await, 2);
    t.hidden(&alice, "delete_forever", json!({"item": doomed_id})).await; // only from the trash
    t.ok(&alice, "trash", json!({"item": doomed_id})).await;
    assert_eq!(code(&t.no(&bob, "delete_forever", json!({"item": doomed_id})).await), "forbidden", "View cannot delete");
    let del = t.ok(&alice, "delete_forever", json!({"item": doomed_id})).await;
    assert_eq!(del["freed_bytes"], json!(11000));
    assert_eq!(t.used(alice.space).await, before - 11000);
    assert_eq!(objects_of(doomed_id).await, 0, "the stored objects are deleted");
    for table in ["e_drive_file", "e_drive_file_version", "e_drive_share", "e_drive_link"] {
        let col = if table == "e_drive_file" { "id" } else { "file" };
        assert_eq!(t.scalar(&format!("select count(*) from {table} where tenant_id = $1 and {col} = $2"), Some(doomed_id)).await, 0, "{table}");
    }
    // A folder deleted for good takes its whole subtree; upkeep purges what stayed too long.
    let old = t.folder(&alice, alice.root, "Old").await;
    let old_inner = t.folder(&alice, old, "Inner").await;
    let old_file = uid(&t.upload(&alice, old_inner, "old.txt", b"old news").await);
    t.ok(&alice, "trash", json!({"item": old})).await;
    assert_eq!(code(&t.no(&alice, "restore", json!({"item": old_inner})).await), "not_found", "inside the trash, not trashed itself");
    t.exec("update e_drive_folder set trashed_at = now() - interval '31 days' where tenant_id = $1 and id = $2", old).await;
    let before = t.used(alice.space).await;
    ferrum_app_drive::maintenance(&k).await.expect("upkeep");
    assert_eq!(t.scalar("select count(*) from e_drive_folder where tenant_id = $1 and id = $2", Some(old_inner)).await, 0);
    assert_eq!(objects_of(old_file).await, 0);
    assert_eq!(t.used(alice.space).await, before - 8);
    let purged = t
        .scalar(
            "select count(*) from e_drive_activity where tenant_id = $1 and action = 'Delete' and actor is null and item_name = 'Old' and $2::uuid is null",
            None,
        )
        .await;
    assert_eq!(purged, 1, "the purge is logged as the system's");
    let emptied_file = uid(&t.upload(&alice, alice.root, "scratch.txt", b"scratch").await);
    t.ok(&alice, "trash", json!({"item": emptied_file})).await;
    let emptied = t.ok(&alice, "empty_trash", json!({"root": alice.root})).await;
    assert_eq!(emptied["deleted"], json!(1));
    t.consistent().await;

    // ───────────── public links ─────────────
    let link = t.ok(&alice, "create_link", json!({"item": report_id})).await;
    let token = link["token"].as_str().unwrap().to_string();
    assert_eq!(link["url"], json!(format!("/api/site/acme/drive/links/{token}")));
    assert_eq!(link["page"], json!(format!("/app/s/acme/{token}")), "the page people open");
    let stored: (String, i64) = {
        let mut tx = k.db.tenant_tx(tenant).await.unwrap();
        let row = sqlx::query_as(
            "select token_hash, (select count(*) from e_drive_link l where l.tenant_id = $1 and to_jsonb(l)::text like '%' || $3 || '%') \
                                  from e_drive_link where tenant_id = $1 and id = $2",
        )
        .bind(tenant)
        .bind(uid(&link))
        .bind(&token)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
        row
    };
    assert_eq!(stored.0, hex::encode(<sha2::Sha256 as sha2::Digest>::digest(token.as_bytes())), "only the token's hash is stored");
    assert_eq!(stored.1, 0, "the token itself is stored nowhere");
    let tok = |s: &str| format!("/links/{s}");
    let view = t.json(t.site(None, "GET", &tok(&token), &[], &[], vec![]).await.unwrap());
    assert_eq!((view["item"]["name"].as_str(), view["link"]["access"].as_str()), (Some("report.pdf"), Some("View")));
    assert!(view["item"].get("owner").is_none() && view["item"].get("permission").is_none(), "guests see no people");
    let preview = t.site(None, "GET", &format!("{}/content", tok(&token)), &[("inline", "1")], &[], vec![]).await.unwrap();
    assert_eq!((preview.content_type.as_str(), preview.body.len()), ("image/png", 1200));
    let refused = t.site(None, "GET", &format!("{}/content", tok(&token)), &[], &[], vec![]).await.expect_err("a View link does not download");
    let unknown = t.site(None, "GET", &tok(&"A".repeat(43)), &[], &[], vec![]).await.expect_err("unknown token");
    let malformed = t.site(None, "GET", &tok("not-a-token"), &[], &[], vec![]).await.expect_err("malformed token");
    assert_eq!((refused.to_string(), code(&refused)), (unknown.to_string(), code(&unknown)));
    assert_eq!(malformed.to_string(), unknown.to_string());
    // A guest: someone outside the workspace gets a link for them alone, by mail. Sharing with them
    // again replaces it; they can only be Viewers.
    let shared = t.ok(&alice, "share", json!({"item": report_id, "email": "Pat@Partner.test", "permission": "View"})).await;
    assert_eq!((shared["guest"].clone(), shared["mailed"].clone(), shared["email"].clone()), (json!(true), json!(true), json!("pat@partner.test")));
    let pats_mail = || async {
        let mut tx = k.db.tenant_tx(tenant).await.unwrap();
        let content: String =
            sqlx::query_scalar("select content from e_communication where tenant_id = $1 and recipients = 'pat@partner.test' order by created_at desc limit 1")
                .bind(tenant)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        tx.commit().await.unwrap();
        content
    };
    let mail = pats_mail().await;
    let page =
        |mail: &str| mail.split("https://erp.acme.test/app/s/acme/").nth(1).map(|rest| rest[..43].to_string()).unwrap_or_else(|| panic!("a link in {mail}"));
    let pats = page(&mail);
    assert!(mail.contains("shared &quot;report.pdf&quot; with you"), "{mail}");
    let seen = t.json(t.site(None, "GET", &tok(&pats), &[], &[], vec![]).await.unwrap());
    assert_eq!((seen["item"]["name"].as_str(), seen["link"]["access"].as_str()), (Some("report.pdf"), Some("Download")));
    let listed = t.ok(&alice, "list_links", json!({"item": report_id})).await;
    assert!(listed["links"].as_array().unwrap().iter().any(|l| l["email"] == json!("pat@partner.test") && l["active"] == json!(true)), "{listed}");
    t.ok(&alice, "share", json!({"item": report_id, "email": "pat@partner.test"})).await;
    t.site(None, "GET", &tok(&pats), &[], &[], vec![]).await.expect_err("the first link stops when a new one is sent");
    assert!(t.site(None, "GET", &tok(&page(&pats_mail().await)), &[], &[], vec![]).await.is_ok());
    let editor = t.no(&alice, "share", json!({"item": report_id, "email": "pat@partner.test", "permission": "Edit"})).await;
    assert!(matches!(editor, Error::Validation(_)), "{editor:?}");

    // A download cap holds under concurrency.
    let capped = t.ok(&alice, "create_link", json!({"item": uid(&notes), "access": "Download", "max_downloads": 3})).await;
    let capped_token = capped["token"].as_str().unwrap().to_string();
    let site = k.hooks.site("drive").unwrap().clone();
    let mut tasks = Vec::new();
    for _ in 0..10 {
        let (k, site, path) = (k.clone(), site.clone(), format!("/links/{capped_token}/content"));
        tasks.push(tokio::spawn(async move { site.handle(&k, request(tenant, None, "GET", &path, &[], &[], vec![])).await }));
    }
    let mut served = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(r) => {
                assert_eq!(r.body, b"# Plan\nship it");
                served += 1;
            }
            Err(e) => assert_eq!(e.to_string(), unknown.to_string()),
        }
    }
    assert_eq!(served, 3, "exactly max_downloads deliveries");
    let links = t.ok(&alice, "list_links", json!({"item": uid(&notes)})).await;
    assert_eq!((links["links"][0]["download_count"].as_i64(), links["links"][0]["active"].as_bool()), (Some(3), Some(false)));
    assert_eq!(t.site(None, "GET", &tok(&capped_token), &[], &[], vec![]).await.expect_err("used up").to_string(), unknown.to_string());
    let public_log = t
        .scalar("select count(*) from e_drive_activity where tenant_id = $1 and file = $2 and action = 'Public Download' and actor is null", Some(uid(&notes)))
        .await;
    assert_eq!(public_log, 3);
    // Passwords: a grant per unlock, ten wrong guesses lock the link.
    let locked = t.ok(&alice, "create_link", json!({"item": secret, "access": "Download", "password": "open sesame"})).await;
    let lt = locked["token"].as_str().unwrap().to_string();
    assert_eq!(code(&t.site(None, "GET", &tok(&lt), &[], &[], vec![]).await.expect_err("no password")), "unauthorized");
    let unlock = |pw: &str| {
        let (t, lt) = (&t, lt.clone());
        let body = serde_json::to_vec(&json!({"password": pw})).unwrap();
        async move { t.site(None, "POST", &format!("/links/{lt}/unlock"), &[], &[], body).await }
    };
    for _ in 0..10 {
        assert_eq!(code(&unlock("guess").await.expect_err("wrong")), "unauthorized");
    }
    assert_eq!(code(&unlock("open sesame").await.expect_err("locked")), "too_many_requests", "even the right password waits out the lock");
    t.exec("update e_drive_link set locked_until = now() - interval '1 second' where tenant_id = $1 and id = $2", uid(&locked)).await;
    let grant = t.json(unlock("open sesame").await.unwrap())["grant"].as_str().unwrap().to_string();
    let inside = t.json(t.site(None, "GET", &tok(&lt), &[], &[("x-drive-grant", &grant)], vec![]).await.unwrap());
    assert_eq!(names(&inside["items"]), ["salary.xlsx"]);
    let got = t.site(None, "GET", &format!("/links/{lt}/content"), &[("file", &salary.to_string()), ("grant", &grant)], &[], vec![]).await.unwrap();
    assert_eq!(got.body, b"PK\x03\x04 salaries");
    assert!(header(&got, "content-disposition").unwrap().starts_with("attachment; filename=\"salary.xlsx\""));
    let (exp, sig) = grant.split_once('.').unwrap();
    let forged = format!("{}.{sig}", exp.parse::<i64>().unwrap() + 3600);
    assert_eq!(code(&t.site(None, "GET", &tok(&lt), &[], &[("x-drive-grant", &forged)], vec![]).await.expect_err("forged grant")), "unauthorized");
    // Nothing outside the shared folder is reachable through it.
    let e = t.site(None, "GET", &format!("/links/{lt}/content"), &[("file", &plan.to_string()), ("grant", &grant)], &[], vec![]).await.expect_err("outside");
    assert_eq!(e.to_string(), unknown.to_string());
    let e = t.site(None, "GET", &tok(&lt), &[("folder", &alice.root.to_string())], &[("x-drive-grant", &grant)], vec![]).await.expect_err("above the share");
    assert_eq!(e.to_string(), unknown.to_string());
    // Expiry, trash and revocation all close a link — and look like an unknown token.
    let dated = t.ok(&alice, "create_link", json!({"item": report_id, "expires_at": "2099-01-01"})).await;
    let dt = dated["token"].as_str().unwrap().to_string();
    t.site(None, "GET", &tok(&dt), &[], &[], vec![]).await.unwrap();
    t.exec("update e_drive_link set expires_at = now() - interval '1 second' where tenant_id = $1 and id = $2", uid(&dated)).await;
    assert_eq!(t.site(None, "GET", &tok(&dt), &[], &[], vec![]).await.expect_err("expired").to_string(), unknown.to_string());
    t.ok(&alice, "trash", json!({"item": report_id})).await;
    assert_eq!(t.site(None, "GET", &tok(&token), &[], &[], vec![]).await.expect_err("trashed").to_string(), unknown.to_string());
    t.ok(&alice, "restore", json!({"item": report_id})).await;
    t.site(None, "GET", &tok(&token), &[], &[], vec![]).await.unwrap();
    assert_eq!(code(&t.no(&bob, "revoke_link", json!({"link": uid(&link)})).await), "not_found", "bob cannot see the file");
    t.ok(&alice, "revoke_link", json!({"link": uid(&link)})).await;
    assert_eq!(t.site(None, "GET", &tok(&token), &[], &[], vec![]).await.expect_err("revoked").to_string(), unknown.to_string());
    // Workspace policy.
    k.update(
        &admin,
        "DriveSettings",
        ferrum_domain::util::id(&t.k.list(&admin, "DriveSettings", &ListQuery::default()).await.unwrap().rows[0], "id").unwrap(),
        obj(json!({"max_link_days": 7, "link_password_required": true})),
        None,
    )
    .await
    .unwrap();
    assert_eq!(code(&t.no(&alice, "create_link", json!({"item": secret, "password": "long enough"})).await), "validation_failed", "must expire within 7 days");
    assert_eq!(
        code(&t.no(&alice, "create_link", json!({"item": secret, "expires_at": (chrono::Utc::now() + chrono::Duration::days(3)).to_rfc3339()})).await),
        "validation_failed"
    );
    t.ok(
        &alice,
        "create_link",
        json!({"item": secret, "password": "long enough", "expires_at": (chrono::Utc::now() + chrono::Duration::days(3)).to_rfc3339()}),
    )
    .await;
    let settings_id = ferrum_domain::util::id(&t.k.list(&admin, "DriveSettings", &ListQuery::default()).await.unwrap().rows[0], "id").unwrap();
    k.update(&admin, "DriveSettings", settings_id, obj(json!({"allow_public_links": false})), None).await.unwrap();
    assert_eq!(code(&t.no(&alice, "create_link", json!({"item": secret})).await), "forbidden");
    assert_eq!(t.site(None, "GET", &tok(&lt), &[], &[("x-drive-grant", &grant)], vec![]).await.expect_err("links off").to_string(), unknown.to_string());
    k.update(&admin, "DriveSettings", settings_id, obj(json!({"allow_public_links": true, "max_link_days": 0, "link_password_required": false})), None)
        .await
        .unwrap();

    // ───────────── quotas hold under concurrent uploads ─────────────
    let gina = t.user("gina@acme.test", &["Drive User"]).await;
    k.update(&erin.ctx, "DriveSpace", gina.space, obj(json!({"quota_mb": 1})), None).await.expect("an administrator sets a quota");
    let mut folders = Vec::new();
    for i in 0..10 {
        folders.push(t.folder(&gina, gina.root, &format!("f{i}")).await);
    }
    let mut tasks = Vec::new();
    for f in folders {
        let (k, site, ctx) = (k.clone(), site.clone(), gina.ctx.clone());
        let fs = f.to_string();
        tasks.push(tokio::spawn(async move {
            site.handle(&k, request(tenant, Some(&ctx), "POST", "/upload", &[("name", "chunk.bin"), ("folder", &fs)], &[], vec![1u8; 300 * 1024])).await
        }));
    }
    let mut ok = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(r) => {
                assert_eq!(r.status, 201);
                ok += 1;
            }
            Err(e) => assert!(e.to_string().contains("storage quota exceeded"), "{e}"),
        }
    }
    assert_eq!(ok, 3, "three 300 KB files fit in 1 MB, a fourth does not");
    assert_eq!(t.used(gina.space).await, 3 * 300 * 1024);
    assert_eq!(t.ok(&gina, "usage", json!({})).await["space"]["quota_bytes"], json!(1 << 20));
    t.consistent().await;

    // ───────────── search filters, recent, starred, comments ─────────────
    let today = alice.ctx.today().format("%Y-%m-%d").to_string();
    let yesterday = (alice.ctx.today() - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    let texts = t.ok(&alice, "search", json!({"type": "Text", "modified_from": today})).await;
    assert!(names(&texts["items"]).contains(&"notes.md".to_string()));
    assert_eq!(t.ok(&alice, "search", json!({"type": "Text", "modified_to": yesterday})).await["items"], json!([]));
    let teams = t.ok(&bob, "search", json!({"type": "folder", "query": "engin"})).await;
    assert_eq!(names(&teams["items"]), ["Engineering"]);
    let pdfs = t.ok(&erin, "search", json!({"owner": "alice@acme.test", "type": "PDF", "sort": "name"})).await;
    assert_eq!(names(&pdfs["items"]), ["report (2).pdf", "REPORT (3).PDF"], "by owner and type (report.pdf holds a PNG)");
    assert_eq!(t.ok(&erin, "search", json!({"owner": "bob@acme.test", "type": "PDF"})).await["items"], json!([]));
    assert_eq!(code(&t.no(&alice, "search", json!({})).await), "validation_failed");
    assert_eq!(code(&t.no(&alice, "search", json!({"type": "Spaceship"})).await), "validation_failed");
    let recent = names(&t.ok(&alice, "recent", json!({})).await["items"]);
    assert!(recent.contains(&"notes.md".to_string()), "{recent:?}");
    t.ok(&alice, "star", json!({"item": uid(&notes)})).await;
    t.ok(&alice, "star", json!({"item": uid(&notes)})).await; // idempotent
    assert_eq!(names(&t.ok(&alice, "starred", json!({})).await["items"]), ["notes.md"]);
    t.ok(&alice, "unstar", json!({"item": uid(&notes)})).await;
    assert_eq!(t.ok(&alice, "starred", json!({})).await["items"], json!([]));
    let mine = t.ok(&carol, "add_comment", json!({"file": uid(&spec), "body": "Mine to delete"})).await;
    t.ok(&carol, "delete_comment", json!({"comment": uid(&mine)})).await;
    assert_eq!(code(&t.no(&frank, "delete_comment", json!({"comment": uid(&c)})).await), "not_found");
    let info = t.ok(&alice, "item_info", json!({"item": uid(&spec)})).await;
    assert_eq!((info["comments"].as_i64(), info["path"].as_str()), (Some(1), Some("Engineering")));

    // ───────────── reports for administrators ─────────────
    let by_user = ferrum_domain::reports::run(&k, &erin.ctx, "drive_storage_by_user", &none).await.expect("by user");
    let alice_row = by_user["rows"].as_array().unwrap().iter().find(|r| r["owner"] == json!("alice@acme.test")).unwrap().clone();
    let alice_used = t.used(alice.space).await;
    assert_eq!(alice_row["used_mb"], json!(format!("{:.1}", alice_used as f64 / 1_048_576.0)));
    let by_team = ferrum_domain::reports::run(&k, &erin.ctx, "drive_storage_by_team", &none).await.expect("by team");
    assert_eq!(by_team["rows"][0]["team"], json!("Engineering"));
    assert_eq!(by_team["rows"][0]["members"], json!(3));
    let by_type = ferrum_domain::reports::run(&k, &erin.ctx, "drive_storage_by_type", &none).await.expect("by type");
    let files_total: i64 = t.scalar("select count(*) from e_drive_file where tenant_id = $1 and $2::uuid is null", None).await;
    assert_eq!(by_type["totals"]["files"], json!(files_total));
    let largest = ferrum_domain::reports::run(&k, &erin.ctx, "drive_largest_files", &HashMap::from([("limit".to_string(), "50".to_string())])).await.unwrap();
    assert_eq!(largest["rows"][0]["name"], json!("spec.txt"));
    assert_eq!(largest["rows"][0]["owner"], json!("Engineering"));
    let public = ferrum_domain::reports::run(&k, &erin.ctx, "drive_shared_externally", &none).await.unwrap();
    let active: Vec<(&str, Option<&str>)> = public["rows"].as_array().unwrap().iter().map(|r| (r["item"].as_str().unwrap(), r["sent_to"].as_str())).collect();
    assert_eq!(
        active,
        [("Secret", None), ("Secret", None), ("report.pdf", Some("pat@partner.test"))],
        "the capped, expired and revoked links are not active; the two Secret links and the one sent to Pat are"
    );
    t.consistent().await;

    // ── online editing over WOPI (src/office.rs) ──
    let err = t.site(Some(&alice.ctx), "POST", "/editor/00000000-0000-0000-0000-000000000000", &[], &[], vec![]).await.unwrap_err();
    assert!(err.to_string().contains("not set up"), "{err}");
    let editor = fake_editor().await;
    // SAFETY: the scenario is this binary's only test; nothing else reads the environment now.
    unsafe {
        std::env::set_var("FERRUM_OFFICE_URL", &editor);
        std::env::set_var("FERRUM_OFFICE_WOPI_URL", "http://ferrum.test/");
        std::env::remove_var("FERRUM_OFFICE_IPS");
    }
    let doc = uid(&t.upload(&alice, alice.root, "plan.docx", b"PK first version").await);
    let opened = t.json(t.site(Some(&alice.ctx), "POST", &format!("/editor/{doc}"), &[], &[], vec![]).await.unwrap());
    assert_eq!(opened["action"], json!("edit"));
    let url = opened["url"].as_str().unwrap();
    // Collabora's close and version history buttons, which post to the web app (C2).
    assert!(
        url.starts_with("http://office.test/browser/x/cool.html?closebutton=1&revisionhistory=1&WOPISrc=http%3A%2F%2Fferrum.test%2Fapi%2Fsite%2Facme%2Fdrive%2Fwopi%2Ffiles%2F"),
        "{url}"
    );
    assert!(url.ends_with(&doc.to_string()), "{url}");
    let token = opened["access_token"].as_str().unwrap().to_string();
    assert!(opened["access_token_ttl"].as_i64().unwrap() > chrono::Utc::now().timestamp_millis());

    let wopi = |file: Uuid, tail: &'static str, method: &'static str, token: String, headers: Vec<(&'static str, String)>, body: Vec<u8>| {
        let t = &t;
        async move {
            let headers: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
            t.site(None, method, &format!("/wopi/files/{file}{tail}"), &[("access_token", token.as_str())], &headers, body).await.unwrap()
        }
    };
    let info = wopi(doc, "", "GET", token.clone(), vec![], vec![]).await;
    assert_eq!(info.status, 200);
    let info = t.json(info);
    assert_eq!((info["BaseFileName"].clone(), info["Size"].clone(), info["UserCanWrite"].clone()), (json!("plan.docx"), json!(16), json!(true)));
    assert_eq!(info["SupportsLocks"], json!(true));
    // The editor talks to the web app (C2): who is in it, and its buttons that open Drive's panels.
    assert_eq!(
        (info["PostMessageOrigin"].clone(), info["EnableShare"].clone(), info["FileVersionPostMessage"].clone(), info["ClosePostMessage"].clone()),
        (json!("https://erp.acme.test"), json!(true), json!(true), json!(true))
    );
    assert_eq!(info["UserExtraInfo"]["mail"], json!("alice@acme.test"));
    let got = wopi(doc, "/contents", "GET", token.clone(), vec![], vec![]).await;
    assert_eq!((got.status, got.body.as_slice()), (200, &b"PK first version"[..]));
    assert_eq!(header(&got, "X-WOPI-ItemVersion"), Some("1"));

    let put = |lock: Option<&str>, body: &'static [u8]| {
        let mut h = vec![("x-wopi-override", "PUT".to_string())];
        if let Some(l) = lock {
            h.push(("x-wopi-lock", l.to_string()));
        }
        wopi(doc, "/contents", "POST", token.clone(), h, body.to_vec())
    };
    let op = |name: &'static str, lock: &'static str| {
        wopi(doc, "", "POST", token.clone(), vec![("x-wopi-override", name.into()), ("x-wopi-lock", lock.into())], vec![])
    };
    assert_eq!(put(None, b"PK no lock").await.status, 409, "a file with content is saved under a lock");
    assert_eq!(op("LOCK", "L1").await.status, 200);
    let taken = op("LOCK", "L2").await;
    assert_eq!((taken.status, header(&taken, "X-WOPI-Lock")), (409, Some("L1")));
    assert_eq!(header(&op("GET_LOCK", "").await, "X-WOPI-Lock"), Some("L1"));
    assert_eq!(put(Some("L2"), b"PK wrong lock").await.status, 409);
    let saved = put(Some("L1"), b"PK second version").await;
    assert_eq!((saved.status, header(&saved, "X-WOPI-ItemVersion")), (200, Some("2")));
    let versions = t.ok(&alice, "list_versions", json!({"file": doc})).await;
    assert_eq!(versions["versions"].as_array().map(Vec::len), Some(2), "{versions}");
    assert_eq!(wopi(doc, "/contents", "GET", token.clone(), vec![], vec![]).await.body, b"PK second version");
    assert_eq!(op("REFRESH_LOCK", "L1").await.status, 200);
    assert_eq!(op("UNLOCK", "L2").await.status, 409);
    assert_eq!(op("UNLOCK", "L1").await.status, 200);
    assert_eq!(header(&op("GET_LOCK", "").await, "X-WOPI-Lock"), Some(""));

    // Tokens: only genuine, for this file, workspace and person.
    let other = uid(&t.upload(&alice, alice.root, "other.docx", b"PK other").await);
    assert_eq!(wopi(other, "", "GET", token.clone(), vec![], vec![]).await.status, 401, "another file");
    let forged = format!("{}x", &token[..token.len() - 1]);
    assert_eq!(wopi(doc, "", "GET", forged, vec![], vec![]).await.status, 401);
    assert_eq!(wopi(doc, "", "GET", String::new(), vec![], vec![]).await.status, 401);

    // Bob sees nothing of Alice's until she shares; then he may read but not save or lock.
    let hidden = t.site(Some(&bob.ctx), "POST", &format!("/editor/{doc}"), &[], &[], vec![]).await.unwrap_err();
    assert_eq!(hidden.to_string(), "Drive item not found");
    t.ok(&alice, "share", json!({"item": doc, "email": "bob@acme.test", "permission": "View"})).await;
    let bobs = t.json(t.site(Some(&bob.ctx), "POST", &format!("/editor/{doc}"), &[], &[], vec![]).await.unwrap());
    let bob_token = bobs["access_token"].as_str().unwrap().to_string();
    let bob_info = t.json(wopi(doc, "", "GET", bob_token.clone(), vec![], vec![]).await);
    assert_eq!(bob_info["UserCanWrite"], json!(false));
    assert_eq!((bob_info["EnableShare"].clone(), bob_info["FileSharingPostMessage"].clone()), (json!(false), json!(false)), "only managers share");
    let bob_lock = wopi(doc, "", "POST", bob_token.clone(), vec![("x-wopi-override", "LOCK".into()), ("x-wopi-lock", "B".into())], vec![]).await;
    assert_eq!(bob_lock.status, 404, "no edit right: answered like a missing file");

    // A blank spreadsheet, filled by its first save without a lock (it is empty).
    let blank = t.json(t.site(Some(&alice.ctx), "POST", "/new", &[("kind", "xlsx"), ("folder", &alice.root.to_string())], &[], vec![]).await.unwrap());
    assert_eq!(blank["name"], json!("Untitled.xlsx"));
    let sheet = uid(&blank);
    let sheet_token =
        t.json(t.site(Some(&alice.ctx), "POST", &format!("/editor/{sheet}"), &[], &[], vec![]).await.unwrap())["access_token"].as_str().unwrap().to_string();
    let first = wopi(sheet, "/contents", "POST", sheet_token, vec![("x-wopi-override", "PUT".into())], b"PK sheet".to_vec()).await;
    assert_eq!(first.status, 200);
    let bad_kind = t.site(Some(&alice.ctx), "POST", "/new", &[("kind", "exe")], &[], vec![]).await.unwrap_err();
    assert!(bad_kind.to_string().contains("kind must be"), "{bad_kind}");

    // Only from the editor's addresses, when the operator lists them.
    unsafe { std::env::set_var("FERRUM_OFFICE_IPS", "10.9.9.9") };
    assert_eq!(wopi(doc, "", "GET", token.clone(), vec![], vec![]).await.status, 403);
    unsafe { std::env::remove_var("FERRUM_OFFICE_IPS") };
    t.consistent().await;

    // ── browser editors (src/office.rs; Ferrum docs/plan/browser-editors.md) ──
    let budget = uid(&t.upload(&alice, alice.root, "budget.xlsx", b"PK budget 1").await);
    let open = |u: &U, file: Uuid, extra: &'static [(&'static str, &'static str)]| {
        let (t, ctx) = (&t, u.ctx.clone());
        async move {
            let mut q = vec![("kind", "browser")];
            q.extend_from_slice(extra);
            t.site(Some(&ctx), "POST", &format!("/editor/{file}"), &q, &[], vec![]).await.map(|r| t.json(r))
        }
    };
    let open_as = |u: &U, session: &'static str| {
        let (t, ctx) = (&t, u.ctx.clone());
        async move {
            let q = [("kind", "browser"), ("session", session)];
            t.json(t.site(Some(&ctx), "POST", &format!("/editor/{budget}"), &q, &[], vec![]).await.unwrap())
        }
    };
    let save = |u: &U, lock: Option<&str>, base: Option<i64>, body: &'static [u8]| {
        let (t, ctx) = (&t, u.ctx.clone());
        let (lock, base) = (lock.map(str::to_string), base.map(|b| b.to_string()));
        async move {
            let q: Vec<(&str, &str)> = [("lock", lock.as_deref()), ("base", base.as_deref())].into_iter().filter_map(|(k, v)| Some((k, v?))).collect();
            t.site(Some(&ctx), "POST", &format!("/files/{budget}/versions"), &q, &[], body.to_vec()).await.map(|r| t.json(r))
        }
    };
    let lock_op = |u: &U, lock: &str, op: &'static str| {
        let (t, ctx, lock) = (&t, u.ctx.clone(), lock.to_string());
        async move { t.site(Some(&ctx), "POST", &format!("/editor/{budget}/lock"), &[("lock", lock.as_str()), ("op", op)], &[], vec![]).await.map(|r| t.json(r)) }
    };
    let err = open(&alice, budget, &[]).await.unwrap_err();
    assert!(err.to_string().contains("not set up"), "{err}");
    let kinds = || {
        let (t, ctx) = (&t, alice.ctx.clone());
        async move { t.json(t.site(Some(&ctx), "GET", "/editors", &[], &[], vec![]).await.unwrap()) }
    };
    assert_eq!(kinds().await, json!({"online": true, "browser": false}));
    // SAFETY: as above.
    unsafe { std::env::set_var("FERRUM_EDITORS_URL", "https://editors.test/") };
    let a1 = open(&alice, budget, &[]).await.unwrap();
    assert_eq!((a1["kind"].clone(), a1["url"].clone(), a1["action"].clone()), (json!("browser"), json!("https://editors.test/relay.html"), json!("edit")));
    assert_eq!((a1["version"].clone(), a1["size"].clone(), a1["held_by"].clone(), a1["lock_seconds"].clone()), (json!(1), json!(11), Value::Null, json!(1800)));
    assert_eq!((a1["folder"].clone(), kinds().await["browser"].clone()), (json!(alice.root), json!(true)));
    let l1 = a1["lock"].as_str().unwrap().to_string();
    assert!(l1.starts_with("browser:"), "{l1}");

    // While the session is open only its saves count, and only from the version it opened.
    let busy = save(&alice, None, None, b"PK upload").await.unwrap_err();
    assert_eq!(code(&busy), "conflict");
    assert!(busy.to_string().contains("'budget.xlsx' is being edited by alice@acme.test in a browser editor"), "{busy}");
    assert_eq!(save(&alice, Some(&l1), Some(1), b"PK budget 2").await.unwrap()["version"], json!(2));
    let stale = save(&alice, Some(&l1), Some(1), b"PK stale").await.unwrap_err();
    assert!(stale.to_string().contains("changed since it was opened (version 1, now 2)"), "{stale}");
    assert_eq!(code(&t.no(&alice, "restore_version", json!({"file": budget, "version": 1})).await), "conflict");

    // Bob may edit it, but not while Alice does: not here, not in the online editor, not by upload.
    t.ok(&alice, "share", json!({"item": budget, "email": "bob@acme.test", "permission": "Edit"})).await;
    let b1 = open(&bob, budget, &[]).await.unwrap();
    assert_eq!(
        (b1["action"].clone(), b1["held_by"].clone(), b1["held_in"].clone(), b1["lock"].clone()),
        (json!("view"), json!("alice@acme.test"), json!("browser"), Value::Null)
    );
    let bob_wopi =
        t.json(t.site(Some(&bob.ctx), "POST", &format!("/editor/{budget}"), &[], &[], vec![]).await.unwrap())["access_token"].as_str().unwrap().to_string();
    assert_eq!(t.json(wopi(budget, "", "GET", bob_wopi.clone(), vec![], vec![]).await)["UserCanWrite"], json!(false), "the online editor opens it read-only");
    let wopi_lock = wopi(budget, "", "POST", bob_wopi.clone(), vec![("x-wopi-override", "LOCK".into()), ("x-wopi-lock", "W".into())], vec![]).await;
    assert_eq!(wopi_lock.status, 409);
    assert_eq!(code(&save(&bob, None, None, b"PK bob").await.unwrap_err()), "conflict");
    assert_eq!(open(&bob, budget, &[("take_over", "true")]).await.unwrap()["action"], json!("view"), "only Alice may move her session");

    // Alice's second tab opens read-only until it takes her session over; the first tab's lock is then stale.
    assert_eq!(open(&alice, budget, &[]).await.unwrap()["action"], json!("view"));
    let a3 = open(&alice, budget, &[("take_over", "true")]).await.unwrap();
    assert_eq!(a3["action"], json!("edit"));
    let l3 = a3["lock"].as_str().unwrap().to_string();
    assert_ne!(l3, l1);
    assert_eq!(code(&save(&alice, Some(&l1), Some(2), b"PK old tab").await.unwrap_err()), "conflict");

    // The lock is refreshed, taken back after it lapsed if nobody took it, and released.
    assert_eq!(lock_op(&alice, &l3, "refresh").await.unwrap()["lock_seconds"], json!(1800));
    assert_eq!(code(&lock_op(&alice, &l1, "refresh").await.unwrap_err()), "conflict");
    assert!(lock_op(&alice, "nonsense", "refresh").await.is_err());
    assert!(lock_op(&alice, &l3, "explode").await.is_err());
    let lapse = "update drive_wopi_lock set expires_at = now() - interval '1 minute' where tenant_id = $1 and file = $2";
    t.exec(lapse, budget).await;
    assert_eq!(save(&alice, Some(&l3), Some(2), b"PK budget 3").await.unwrap()["version"], json!(3));
    let live = "select count(*) from drive_wopi_lock where tenant_id = $1 and file = $2 and expires_at > now()";
    assert_eq!(t.scalar(live, Some(budget)).await, 1, "the lapsed lock was taken back");
    t.exec(lapse, budget).await;
    let b2 = open(&bob, budget, &[]).await.unwrap();
    assert_eq!(b2["action"], json!("edit"), "a lapsed lock is free");
    let lb = b2["lock"].as_str().unwrap().to_string();
    let late = save(&alice, Some(&l3), Some(3), b"PK late").await.unwrap_err();
    assert!(late.to_string().contains("being edited by bob@acme.test in a browser editor"), "{late}");
    assert_eq!(lock_op(&bob, &lb, "release").await.unwrap()["released"], json!(true));
    assert_eq!(lock_op(&bob, &lb, "release").await.unwrap()["released"], json!(true), "releasing twice is fine");
    assert_eq!(t.scalar(live, Some(budget)).await, 0);

    // The same page launching again (React mounts it twice in development) gets its own lock back;
    // another page of the same person does not.
    let first = open_as(&alice, "0123456789abcdef0123456789abcdef").await;
    let again = open_as(&alice, "0123456789ABCDEF0123456789ABCDEF").await;
    assert_eq!((first["action"].clone(), again["action"].clone()), (json!("edit"), json!("edit")));
    assert_eq!(again["lock"], first["lock"]);
    assert_eq!(open_as(&alice, "fedcba9876543210fedcba9876543210").await["action"], json!("view"));
    assert_eq!(open_as(&alice, "not-hex").await["action"], json!("view"), "a malformed key is a page of its own");
    assert_eq!(lock_op(&alice, first["lock"].as_str().unwrap(), "release").await.unwrap()["released"], json!(true));

    // An online editor session holds the file the same way and says who took it.
    let alice_wopi =
        t.json(t.site(Some(&alice.ctx), "POST", &format!("/editor/{budget}"), &[], &[], vec![]).await.unwrap())["access_token"].as_str().unwrap().to_string();
    let wopi_op =
        |name: &'static str| wopi(budget, "", "POST", alice_wopi.clone(), vec![("x-wopi-override", name.into()), ("x-wopi-lock", "W1".into())], vec![]);
    assert_eq!(wopi_op("LOCK").await.status, 200);
    let b3 = open(&bob, budget, &[]).await.unwrap();
    assert_eq!((b3["action"].clone(), b3["held_by"].clone(), b3["held_in"].clone()), (json!("view"), json!("alice@acme.test"), json!("online")));
    let during = save(&bob, None, None, b"PK during").await.unwrap_err();
    assert!(during.to_string().contains("in the online editor"), "{during}");
    assert_eq!(wopi_op("UNLOCK").await.status, 200);

    // A check-out holds it too; a viewer opens read-only; a stranger sees nothing.
    t.ok(&alice, "check_out", json!({"file": budget})).await;
    let b4 = open(&bob, budget, &[]).await.unwrap();
    assert_eq!((b4["action"].clone(), b4["held_by"].clone(), b4["held_in"].clone()), (json!("view"), json!("alice@acme.test"), json!("checkout")));
    t.ok(&alice, "check_in", json!({"file": budget})).await;
    let viewer = open(&bob, doc, &[]).await.unwrap();
    assert_eq!((viewer["action"].clone(), viewer["held_by"].clone(), viewer["lock"].clone()), (json!("view"), Value::Null, Value::Null));
    assert_eq!(open(&frank, budget, &[]).await.unwrap_err().to_string(), "Drive item not found");
    unsafe { std::env::remove_var("FERRUM_EDITORS_URL") };
    t.consistent().await;

    // ── working together (src/collab.rs; Ferrum docs/plan/collaboration.md, C1) ──
    let told = |u: &U, like: &'static str| {
        let (t, id) = (&t, u.id);
        async move { t.scalar(&format!("select count(*) from notification where tenant_id = $1 and user_id = $2 and title like '{like}'"), Some(id)).await }
    };
    let notes = uid(&t.upload(&alice, alice.root, "notes.txt", b"plans").await);
    t.ok(&alice, "share", json!({"item": notes, "email": "bob@acme.test", "permission": "Comment"})).await;

    // A mention tells those who may see the file; the owner hears of comments by others.
    let said =
        t.ok(&bob, "add_comment", json!({"file": notes, "body": "@alice see this, @frank too", "mentions": ["alice@acme.test", "FRANK@acme.test"]})).await;
    assert_eq!(said["mentioned"], json!(["alice@acme.test"]), "frank may not see the file");
    assert_eq!(told(&alice, "% mentioned you on \"notes.txt\"").await, 1);
    assert_eq!(told(&alice, "% commented on \"notes.txt\"").await, 0, "a mention is enough");
    assert_eq!(told(&frank, "% mentioned you on%").await, 0);
    t.ok(&bob, "add_comment", json!({"file": notes, "body": "and one more thing"})).await;
    assert_eq!(told(&alice, "% commented on \"notes.txt\"").await, 1);
    let reply = t.ok(&alice, "add_comment", json!({"file": notes, "body": "thanks @bob", "mentions": "bob@acme.test, alice@acme.test"})).await;
    assert_eq!(reply["mentioned"], json!(["bob@acme.test"]), "nobody is told of their own comment");
    assert_eq!(told(&bob, "% mentioned you on \"notes.txt\"").await, 1);

    // Presence: who has the file open now, for those who may see it.
    let beat = |u: &U, file: Uuid, mode: &'static str| {
        let (t, ctx) = (&t, u.ctx.clone());
        async move { t.site(Some(&ctx), "POST", &format!("/presence/{file}"), &[("mode", mode)], &[], vec![]).await.map(|r| t.json(r)) }
    };
    let who = |u: &U, files: String| {
        let (t, ctx) = (&t, u.ctx.clone());
        async move { t.json(t.site(Some(&ctx), "GET", "/presence", &[("files", files.as_str())], &[], vec![]).await.unwrap()) }
    };
    assert_eq!(beat(&alice, notes, "edit").await.unwrap()["present"], json!([]));
    assert_eq!(beat(&bob, notes, "view").await.unwrap()["present"], json!([{"name": "alice", "mode": "edit"}]));
    assert_eq!(beat(&alice, notes, "edit").await.unwrap()["present"], json!([{"name": "bob", "mode": "view"}]));
    assert_eq!(who(&bob, format!("{notes},{doc}")).await["present"], json!({notes.to_string(): [{"name": "alice", "mode": "edit"}]}));
    assert_eq!(who(&frank, notes.to_string()).await["present"], json!({}), "a file frank may not see");
    assert_eq!(beat(&frank, notes, "view").await.unwrap_err().to_string(), "Drive item not found");
    assert!(beat(&alice, notes, "dance").await.is_err());
    // Editing a file a browser editor holds: in that editor, which nobody can join (C2).
    t.exec(
        "insert into drive_wopi_lock (tenant_id, file, lock, holder, expires_at) values ($1, $2, 'browser:s1', 'alice', now() + interval '1 minute')",
        notes,
    )
    .await;
    assert_eq!(beat(&bob, notes, "view").await.unwrap()["present"], json!([{"name": "alice", "mode": "edit", "editor": "browser"}]));
    assert_eq!(beat(&alice, notes, "edit").await.unwrap()["present"], json!([{"name": "bob", "mode": "view"}]), "only editing is in the editor");
    t.exec("update drive_wopi_lock set lock = 'collabora-lock' where tenant_id = $1 and file = $2", notes).await;
    assert_eq!(who(&bob, notes.to_string()).await["present"], json!({notes.to_string(): [{"name": "alice", "mode": "edit"}]}), "the online editor is shared");
    t.exec("delete from drive_wopi_lock where tenant_id = $1 and file = $2", notes).await;
    beat(&alice, notes, "gone").await.unwrap();
    assert_eq!(beat(&bob, notes, "view").await.unwrap()["present"], json!([]), "alice left");
    t.exec("update drive_presence set seen_at = now() - interval '2 minutes' where tenant_id = $1 and file = $2", notes).await;
    assert_eq!(who(&alice, notes.to_string()).await["present"], json!({}), "a page that stopped reporting is gone");

    // Asking for access: the owner (or a team folder's managers) is told once a day; the answer
    // never says whether the item exists.
    let asked = t.ok(&gina, "request_access", json!({"item": notes, "message": "for the review"})).await;
    assert_eq!(asked, json!({"requested": true}));
    assert_eq!(told(&alice, "gina (gina@acme.test) asks for access to \"notes.txt\"").await, 1);
    assert_eq!(t.ok(&gina, "request_access", json!({"item": notes})).await, json!({"requested": true}));
    assert_eq!(told(&alice, "% asks for access to \"notes.txt\"").await, 1, "once a day");
    assert_eq!(t.ok(&gina, "request_access", json!({"item": Uuid::now_v7()})).await, json!({"requested": true}), "no such item: the same answer");
    assert_eq!(t.ok(&bob, "request_access", json!({"item": notes})).await, json!({"has_access": true}));
    t.ok(&gina, "request_access", json!({"item": eng})).await;
    assert_eq!(told(&alice, "% asks for access to \"Engineering\"").await, 1, "a team folder's manager is told");
    assert_eq!(told(&bob, "% asks for access to \"Engineering\"").await, 0, "an editor is not");
    t.consistent().await;

    // ── documents edited live (src/docs.rs; Ferrum docs/plan/collaboration.md, C3) ──
    use ferrum_kernel::{DocAccess, coedit};
    use yrs::{Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};
    let host = k.hooks.doc_host("drive").expect("Drive hosts live documents").clone();
    let made = t.json(t.site(Some(&alice.ctx), "POST", "/new", &[("kind", "fdoc"), ("name", "Brief")], &[], vec![]).await.unwrap());
    let brief = uid(&made);
    assert_eq!(
        (made["name"].as_str(), made["file_type"].as_str(), made["content_type"].as_str()),
        (Some("Brief.fdoc"), Some("Document"), Some("application/vnd.ferrum.doc"))
    );
    t.ok(&alice, "share", json!({"item": brief, "email": "bob@acme.test", "permission": "Comment"})).await;
    assert_eq!(host.access(&k, &alice.ctx, brief).await.unwrap(), DocAccess::Write);
    assert_eq!(host.access(&k, &bob.ctx, brief).await.unwrap(), DocAccess::Read, "comment access reads");
    assert_eq!(host.access(&k, &frank.ctx, brief).await.unwrap(), DocAccess::None, "no access, no document");
    assert_eq!(host.access(&k, &alice.ctx, notes).await.unwrap(), DocAccess::None, "not a live document");
    assert_eq!(host.initial(&k, tenant, brief).await.unwrap(), Some(vec![]), "a new document is empty");

    // What the editors typed, as the platform hands it over: a version, by the first of them.
    let typed = |words: &[&str]| {
        let doc = coedit::new_doc();
        let fragment = doc.get_or_insert_xml_fragment(coedit::FRAGMENT);
        let mut txn = doc.transact_mut();
        let h = fragment.push_back(&mut txn, XmlElementPrelim::empty("heading"));
        h.push_back(&mut txn, XmlTextPrelim::new("Q4 brief"));
        for w in words {
            let p = fragment.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(&mut txn, XmlTextPrelim::new(*w));
        }
        drop(txn);
        doc
    };
    let first = typed(&["Goals"]);
    let state = coedit::encode(&first);
    host.saved(&k, tenant, brief, &state, &coedit::plain_text(&first), &[alice.id, bob.id]).await.unwrap();
    host.saved(&k, tenant, brief, &state, &coedit::plain_text(&first), &[alice.id]).await.unwrap();
    let versions = t.ok(&alice, "list_versions", json!({"file": brief})).await;
    let v = &versions["versions"][0];
    assert_eq!((versions["versions"].as_array().unwrap().len(), v["version"].as_i64()), (2, Some(2)), "unchanged content adds no version");
    assert_eq!((v["author"].as_str(), v["comment"].as_str()), (Some("alice@acme.test"), Some("Edited live by 2 people")));

    // Its editors kept typing: storage holds more than the last version, and everything reads that.
    let live = coedit::decode(&state);
    let change = {
        let fragment = live.get_or_insert_xml_fragment(coedit::FRAGMENT);
        let mut txn = live.transact_mut();
        let p = fragment.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        p.push_back(&mut txn, XmlTextPrelim::new("Risks"));
        txn.encode_update_v1()
    };
    let mut tx = k.db.tenant_tx(tenant).await.unwrap();
    sqlx::query("insert into coedit_doc (tenant_id, package, id, seq, snapshot) values ($1, 'drive', $2, 1, $3)")
        .bind(tenant)
        .bind(brief)
        .bind(&state)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("insert into coedit_update (tenant_id, package, doc, seq, data) values ($1, 'drive', $2, 1, $3)")
        .bind(tenant)
        .bind(brief)
        .bind(&change)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let words = coedit::plain_text(&live);
    assert_eq!(words, "Q4 brief\nGoals\nRisks");
    let got = t.ok(&bob, "download", json!({"file": brief})).await;
    assert_eq!(got["text"], json!(words), "agents read its words, as typed");
    let txt = t.site(Some(&bob.ctx), "GET", &format!("/files/{brief}/content"), &[("format", "txt")], &[], vec![]).await.unwrap();
    assert_eq!((txt.content_type.as_str(), String::from_utf8(txt.body).unwrap()), ("text/plain; charset=utf-8", words.clone()));
    let page = t.site(Some(&bob.ctx), "GET", &format!("/files/{brief}/content"), &[("format", "html")], &[], vec![]).await.unwrap();
    let html = String::from_utf8(page.body.clone()).unwrap();
    assert!(html.contains("<title>Brief</title>") && html.contains("<h1>Q4 brief</h1>") && html.contains("<p>Risks</p>"), "{html}");
    assert!(header(&page, "content-disposition").unwrap().starts_with("attachment; filename=\"Brief.html\""));
    assert!(header(&page, "content-security-policy").unwrap().contains("sandbox"));
    let old = t.site(Some(&bob.ctx), "GET", &format!("/files/{brief}/content"), &[("format", "txt"), ("version", "2")], &[], vec![]).await.unwrap();
    assert_eq!(String::from_utf8(old.body).unwrap(), "Q4 brief\nGoals", "a version reads as it was");
    let pdf = t.site(Some(&bob.ctx), "GET", &format!("/files/{brief}/content"), &[("format", "pdf")], &[], vec![]).await.unwrap_err();
    assert_eq!(code(&pdf), "unavailable", "no PDF renderer on this server: {pdf}");
    let copied = t.ok(&alice, "copy", json!({"item": brief, "to": alice.root})).await;
    let copy_text = t.ok(&alice, "download", json!({"file": uid(&copied)})).await;
    assert_eq!(copy_text["text"], json!(words), "a copy takes what its editors typed, not the last version");

    // Nothing changes its content around the editor; it is never checked out.
    let e = t.no(&alice, "upload_version", json!({"file": brief, "text": "plain"})).await;
    assert!(e.to_string().contains("is edited live"), "{e}");
    let e = t.site(Some(&alice.ctx), "POST", &format!("/files/{brief}/versions"), &[], &[], b"bytes".to_vec()).await.unwrap_err();
    assert!(e.to_string().contains("is edited live"), "{e}");
    let e = t.no(&alice, "upload", json!({"folder": alice.root, "name": "Brief.fdoc", "text": "x", "on_conflict": "replace"})).await;
    assert!(e.to_string().contains("is edited live"), "{e}");
    let e = t.no(&alice, "check_out", json!({"file": brief})).await;
    assert!(e.to_string().contains("is edited live"), "{e}");

    // An old version comes back beside it, as a document of its own.
    let restored = t.ok(&alice, "restore_version", json!({"file": brief, "version": 1})).await;
    assert_eq!(restored["name"], json!("Brief (version 1).fdoc"));
    assert_eq!(t.ok(&alice, "list_versions", json!({"file": brief})).await["versions"][0]["version"], json!(2), "the live document is untouched");

    // Guests read it as a page, whatever link they have; only Download links get its words.
    let link = t.ok(&alice, "create_link", json!({"item": brief})).await;
    let token = link["token"].as_str().unwrap().to_string();
    let shown = t.site(None, "GET", &format!("/links/{token}/content"), &[("inline", "1")], &[], vec![]).await.unwrap();
    assert_eq!(shown.content_type, "text/html; charset=utf-8");
    assert!(String::from_utf8(shown.body.clone()).unwrap().contains("<p>Risks</p>"));
    assert_eq!(header(&shown, "cache-control"), Some("no-store"));
    assert!(t.site(None, "GET", &format!("/links/{token}/content"), &[("format", "txt")], &[], vec![]).await.is_err(), "a View link only shows it");

    // Documents for people and AI agents: made from Markdown, read back, added to while live.
    let made = t
        .ok(
            &alice,
            "create_document",
            json!({"title": "Launch notes", "markdown": "# Launch\n\n- [ ] book the hall\n- [x] invite press\n\n| Owner | Due |\n|---|---|\n| Ana | Friday |"}),
        )
        .await;
    let launch = uid(&made);
    assert_eq!((made["name"].as_str(), made["content_type"].as_str()), (Some("Launch notes.fdoc"), Some("application/vnd.ferrum.doc")));
    let md = t.ok(&alice, "read_document", json!({"file": launch})).await;
    let content = md["content"].as_str().unwrap();
    assert!(content.starts_with("# Launch\n\n- [ ] book the hall\n- [x] invite press\n\n| Owner | Due |\n|---|---|\n| Ana | Friday |"), "{content}");
    let added = t.ok(&alice, "append_to_document", json!({"file": launch, "markdown": "## Risks\n\nThe *venue* may move."})).await;
    assert_eq!(added["appended"], json!(true));
    let as_text = t.ok(&alice, "read_document", json!({"file": launch, "format": "text"})).await;
    assert!(as_text["content"].as_str().unwrap().ends_with("Risks\nThe venue may move."), "{as_text}");
    let html = t.ok(&alice, "read_document", json!({"file": launch, "format": "html", "version": 1})).await;
    assert!(html["content"].as_str().unwrap().contains("<h1>Launch</h1>") && !html["content"].as_str().unwrap().contains("Risks"), "a version reads as it was");
    assert_eq!(t.scalar("select seq from coedit_doc where tenant_id = $1 and id = $2", Some(launch)).await, 1, "added as a change of the live document");
    t.hidden(&bob, "append_to_document", json!({"file": launch, "markdown": "sneaky"})).await;
    t.ok(&alice, "share", json!({"item": launch, "email": "bob@acme.test", "permission": "Comment"})).await;
    assert_eq!(code(&t.no(&bob, "append_to_document", json!({"file": launch, "markdown": "sneaky"})).await), "forbidden", "commenters only read");
    assert!(t.ok(&bob, "read_document", json!({"file": launch})).await["content"].as_str().unwrap().contains("## Risks"));
    let e = t.no(&alice, "read_document", json!({"file": notes})).await;
    assert!(e.to_string().contains("is not a document edited live"), "{e}");
    let e = t.no(&alice, "append_to_document", json!({"file": launch, "markdown": "   "})).await;
    assert_eq!(code(&e), "validation_failed");

    // Search finds documents by what they say, showing where; `live` keeps to documents.
    let found = t.ok(&alice, "search", json!({"query": "venue"})).await;
    let hit = found["items"].as_array().unwrap().iter().find(|i| uid(i) == launch).expect("found by its words");
    let snippet = hit["snippet"].as_str().unwrap();
    assert!(snippet.contains("Risks · The «venue» may move") && !snippet.contains('\n'), "{snippet}");
    let named = t.ok(&alice, "search", json!({"query": "Launch", "live": true})).await;
    assert!(named["items"].as_array().unwrap().iter().all(|i| i["content_type"] == "application/vnd.ferrum.doc"));
    let every = t.ok(&alice, "search", json!({"live": true})).await;
    let doc_names: Vec<String> = names(&every["items"]);
    assert!(doc_names.contains(&"Launch notes.fdoc".to_string()) && doc_names.iter().all(|n| n.ends_with(".fdoc")), "{doc_names:?}");
    assert!(t.ok(&bob, "search", json!({"query": "venue"})).await["items"].as_array().unwrap().iter().any(|i| uid(i) == launch), "shared with bob");
    assert!(!t.ok(&frank, "search", json!({"query": "venue"})).await["items"].as_array().unwrap().iter().any(|i| uid(i) == launch), "not frank's");
    t.ok(&alice, "star", json!({"item": launch})).await;
    t.ok(&alice, "star", json!({"item": notes})).await;
    for view in ["recent", "starred"] {
        let all = t.ok(&alice, view, json!({})).await;
        let docs = t.ok(&alice, view, json!({"live": true})).await;
        assert!(all["items"].as_array().unwrap().len() > docs["items"].as_array().unwrap().len(), "{view}");
        assert!(docs["items"].as_array().unwrap().iter().all(|i| i["content_type"] == "application/vnd.ferrum.doc"), "{view}");
    }
    assert_eq!(names(&t.ok(&bob, "shared_with_me", json!({"live": true})).await["items"]), ["Launch notes.fdoc", "Brief.fdoc"], "newest share first");

    // Documents from before Drive kept their words get them from upkeep.
    t.exec("delete from drive_doc_words where tenant_id = $1 and file = $2", launch).await;
    assert!(!t.ok(&alice, "search", json!({"query": "venue"})).await["items"].as_array().unwrap().iter().any(|i| uid(i) == launch));
    ferrum_app_drive::maintenance(&k).await.unwrap();
    assert!(t.ok(&alice, "search", json!({"query": "venue"})).await["items"].as_array().unwrap().iter().any(|i| uid(i) == launch), "kept again");

    // In the trash nobody opens it; deleted for good, its live content goes too.
    t.ok(&alice, "trash", json!({"item": brief})).await;
    assert_eq!(host.access(&k, &alice.ctx, brief).await.unwrap(), DocAccess::None);
    host.saved(&k, tenant, brief, &coedit::encode(&live), &words, &[alice.id]).await.unwrap();
    assert_eq!(
        t.scalar("select count(*) from e_drive_file_version where tenant_id = $1 and file = $2", Some(brief)).await,
        2,
        "no versions while in the trash"
    );
    t.ok(&alice, "restore", json!({"item": brief})).await;
    assert_eq!(host.access(&k, &alice.ctx, brief).await.unwrap(), DocAccess::Write);
    t.ok(&alice, "trash", json!({"item": brief})).await;
    t.ok(&alice, "delete_forever", json!({"item": brief})).await;
    assert_eq!(t.scalar("select count(*) from coedit_doc where tenant_id = $1 and id = $2", Some(brief)).await, 0);
    assert_eq!(t.scalar("select count(*) from drive_doc_words where tenant_id = $1 and file = $2", Some(brief)).await, 0, "its words go too");
    t.consistent().await;
}

/// An editor server that only answers discovery: Writer for docx, Calc for xlsx.
async fn fake_editor() -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const XML: &str = r#"<wopi-discovery><net-zone name="external-http">
<app name="writer"><action default="true" ext="docx" name="edit" urlsrc="http://office.test/browser/x/cool.html?"/></app>
<app name="calc"><action default="true" ext="xlsx" name="edit" urlsrc="http://office.test/browser/x/cool.html?"/></app>
</net-zone></wopi-discovery>"#;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await;
                let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: text/xml\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{XML}", XML.len());
                let _ = s.write_all(reply.as_bytes()).await;
            });
        }
    });
    format!("http://{addr}")
}

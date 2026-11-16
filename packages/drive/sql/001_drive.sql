-- Names are unique per folder, ignoring case, among items not in the trash (the trash may hold
-- several "Report.pdf"; restoring renames on a clash). Team folders are unique by name.
create unique index if not exists drive_file_live_name on e_drive_file (tenant_id, folder, lower(name)) where not trashed;
create unique index if not exists drive_folder_live_name on e_drive_folder (tenant_id, parent, lower(name)) where not trashed and parent is not null;
create unique index if not exists drive_team_live_name on e_drive_folder (tenant_id, lower(name)) where is_team and not trashed;

-- Access is inherited down the tree: every item lists its enclosing folders, so "everything in
-- folder X" and "everything under a folder shared with me" are index lookups, not tree walks.
create index if not exists drive_folder_ancestors on e_drive_folder using gin (ancestors);
create index if not exists drive_file_ancestors on e_drive_file using gin (ancestors);

-- Trashed items: the purge job and the "is any enclosing folder trashed" test read only these.
create index if not exists drive_folder_trashed on e_drive_folder (tenant_id, trashed_at) where trashed;
create index if not exists drive_file_trashed on e_drive_file (tenant_id, trashed_at) where trashed;

-- Activity is read newest first: per person (recent files), per file and per folder.
create index if not exists drive_activity_actor on e_drive_activity (tenant_id, actor, created_at desc) where actor is not null;
create index if not exists drive_activity_file on e_drive_activity (tenant_id, file, created_at desc) where file is not null;
create index if not exists drive_activity_folder on e_drive_activity (tenant_id, folder, created_at desc) where folder is not null;

-- Usage counters never go negative: a refund larger than the charge is a bug, refused loudly.
alter table e_drive_space add constraint drive_space_used_not_negative check (used_bytes >= 0);
alter table e_drive_folder add constraint drive_folder_used_not_negative check (used_bytes >= 0);

-- A share or link names exactly one item; a share names exactly one person or role.
alter table e_drive_share add constraint drive_share_one_item check ((file is null) <> (folder is null));
alter table e_drive_share add constraint drive_share_one_principal check ((email is null) <> (role is null));
alter table e_drive_link add constraint drive_link_one_item check ((file is null) <> (folder is null));
alter table e_drive_star add constraint drive_star_one_item check ((file is null) <> (folder is null));

-- Online editing (src/office.rs): the WOPI lock an editor session holds on a file, lapsing 30
-- minutes after its last refresh, and who holds it (browser editors), so the others can be told who
-- is editing it.
create table drive_wopi_lock (
  tenant_id uuid not null references tenant(id) on delete cascade,
  file uuid not null,
  lock text not null check (length(lock) between 1 and 1024),
  expires_at timestamptz not null,
  holder text check (length(holder) <= 320),
  primary key (tenant_id, file)
);
alter table drive_wopi_lock enable row level security;
alter table drive_wopi_lock force row level security;
create policy tenant_isolation on drive_wopi_lock
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));

-- Collaboration (src/collab.rs): who has a file open now, reported by open pages every 30 seconds,
-- and requests for access, one per item and person a day.
create table drive_presence (
  tenant_id uuid not null references tenant(id) on delete cascade,
  file uuid not null,
  user_id uuid not null,
  name text not null check (length(name) <= 200),
  mode text not null check (mode in ('view', 'edit')),
  seen_at timestamptz not null,
  primary key (tenant_id, file, user_id)
);
create index drive_presence_seen on drive_presence (tenant_id, seen_at);
alter table drive_presence enable row level security;
alter table drive_presence force row level security;
create policy tenant_isolation on drive_presence
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));

create table drive_access_request (
  tenant_id uuid not null references tenant(id) on delete cascade,
  item uuid not null,
  requester uuid not null,
  asked_at timestamptz not null,
  primary key (tenant_id, item, requester)
);
alter table drive_access_request enable row level security;
alter table drive_access_request force row level security;
create policy tenant_isolation on drive_access_request
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));

-- The words of documents edited live (src/docs.rs), kept whenever a version is written: search
-- finds documents by what they say.
create table drive_doc_words (
  tenant_id uuid not null references tenant(id) on delete cascade,
  file uuid not null,
  words text not null,
  search tsvector generated always as (to_tsvector('simple', words)) stored,
  primary key (tenant_id, file)
);
create index drive_doc_words_search on drive_doc_words using gin (search);
alter table drive_doc_words enable row level security;
alter table drive_doc_words force row level security;
create policy tenant_isolation on drive_doc_words
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));

-- Images in documents edited live (src/images.rs). Each document keeps its own, under the ids the
-- document names them by; a copy of a document gets copies. The bytes are platform files attached
-- to the document's Drive File: they go when it is deleted for good, and its space pays for them.
create table drive_doc_image (
  tenant_id uuid not null references tenant(id) on delete cascade,
  file uuid not null,
  id uuid not null,
  object uuid not null,
  content_type text not null,
  size bigint not null,
  width int not null,
  height int not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (tenant_id, file, id)
);
create index drive_doc_image_id on drive_doc_image (tenant_id, id);
alter table drive_doc_image enable row level security;
alter table drive_doc_image force row level security;
create policy tenant_isolation on drive_doc_image
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));

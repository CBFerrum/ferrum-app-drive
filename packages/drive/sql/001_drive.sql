-- Drive: the per-tenant key that signs unlock grants of password-protected public links, kept out
-- of every entity (so no API, export, event or audit trail can reveal it).
create table drive_secret (
  tenant_id uuid primary key references tenant(id) on delete cascade,
  secret bytea not null check (length(secret) = 32),
  created_at timestamptz not null default now()
);
alter table drive_secret enable row level security;
alter table drive_secret force row level security;
create policy tenant_isolation on drive_secret
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));

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

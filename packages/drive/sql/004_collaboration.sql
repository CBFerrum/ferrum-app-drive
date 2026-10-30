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

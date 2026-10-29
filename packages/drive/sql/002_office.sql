-- Online editing (src/office.rs): the WOPI lock an editor session holds on a file, lapsing 30
-- minutes after its last refresh.
create table drive_wopi_lock (
  tenant_id uuid not null references tenant(id) on delete cascade,
  file uuid not null,
  lock text not null check (length(lock) between 1 and 1024),
  expires_at timestamptz not null,
  primary key (tenant_id, file)
);
alter table drive_wopi_lock enable row level security;
alter table drive_wopi_lock force row level security;
create policy tenant_isolation on drive_wopi_lock
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));

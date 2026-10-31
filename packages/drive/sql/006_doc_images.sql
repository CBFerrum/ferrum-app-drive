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

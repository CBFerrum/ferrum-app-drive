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

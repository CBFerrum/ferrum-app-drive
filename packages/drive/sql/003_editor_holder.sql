-- Browser editors (src/office.rs): who holds a file's editor lock, so the others can be told who
-- is editing it. Empty for locks taken before this column existed.
alter table drive_wopi_lock add column if not exists holder text check (length(holder) <= 320);

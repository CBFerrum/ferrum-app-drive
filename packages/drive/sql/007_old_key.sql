-- Drive 0.17: links' grants and editor tokens are signed with keys derived from Drive's own key in the vault
-- (src/keys.rs). The workspace's key in drive_secret signs nothing any more: when it stopped, so that what it signed
-- before is checked (from the vault, where it moves sealed) for ten hours and a day after, and not after. The build
-- before this one still reads the table; its rows go in the release after this one.
alter table drive_secret add column if not exists retired_at timestamptz;

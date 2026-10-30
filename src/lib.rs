//! Drive: team and personal file storage — folders, versions, check-out, sharing with people and
//! roles, team folders, expiring public links, trash, quotas, search and storage reports.
//!
//! * Access control (`acl`): a caller's level on an item comes from their own space, their
//!   team-folder memberships and unexpired shares (to them or a role they hold) on the item or any
//!   folder above it. Folders, files, versions, shares, links, comments and activity are readable
//!   through the generic records API by Drive administrators only; everyone else reaches Drive
//!   through actions on their own Drive Space (generic API and MCP) and the Site endpoints, which
//!   check every item with `tree::open`. Nothing a person may not see is ever listed, counted,
//!   named in a breadcrumb or served.
//! * Content (`files`): bytes are stored through the kernel's file store, attached to their Drive
//!   file (so the platform's own file endpoints apply Drive File's access rules); every version is
//!   its own stored object; types come from the bytes.
//! * Sharing and public links (`sharing`), the data layer (`tree`), operations (`ops`), HTTP
//!   (`site`), reports (`reports`) and upkeep (`upkeep`). See `packages/drive/README.md`.

mod acl;
mod content;
mod files;
mod hooks;
mod office;
mod ops;
mod reports;
mod sharing;
mod site;
mod tree;
mod upkeep;

use chrono::{DateTime, Duration, NaiveDate, NaiveTime, SecondsFormat, TimeZone, Utc};
use ferrum_domain::reports::ReportSource;
use ferrum_kernel::{HookRegistry, Kernel, Result};
use std::sync::Arc;

include!(concat!(env!("OUT_DIR"), "/packages.rs"));

/// This app's manifest (`app.yaml`).
pub const MANIFEST: &str = include_str!("../app.yaml");

/// The manifest of Drive's add-on Browser editors (`addons/editors/app.yaml`): no code, only the
/// editors it contributes to `drive.editor`. It ships with Drive.
pub const EDITORS_MANIFEST: &str = include_str!("../addons/editors/app.yaml");

/// This app's metadata packages, embedded at build time.
pub fn packages() -> std::result::Result<Vec<ferrum_meta::Package>, ferrum_meta::MetaError> {
    ferrum_meta::catalog::load_embedded(EMBEDDED)
}

/// Registers this app's document hooks (and web endpoints).
pub fn register(hooks: &mut HookRegistry) {
    hooks.register("DriveSpace", Arc::new(hooks::SpaceHook));
    for entity in ["DriveFolder", "DriveFile", "DriveFileVersion", "DriveShare", "DriveLink", "DriveActivity", "DriveComment", "DriveStar"] {
        hooks.register(entity, Arc::new(hooks::Guard));
    }
    hooks.add_site("drive", Arc::new(site::DriveSite));
}

/// This app's reports.
pub fn reports() -> Vec<Arc<dyn ReportSource>> {
    vec![Arc::new(reports::DriveReports)]
}

/// Periodic upkeep: every minute, on one replica at a time (advisory lock); must be idempotent and cheap.
/// Deletes for good what stayed in the trash too long and removes expired shares.
pub async fn maintenance(k: &Kernel) -> Result<()> {
    upkeep::run(k).await
}

/// Now, as stored in datetime fields.
pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The instant a calendar day starts in time zone `tz` (UTC for unknown zones). When a daylight
/// saving change skips midnight, the day starts at its first local time.
pub(crate) fn day_start(tz: &str, date: NaiveDate) -> DateTime<Utc> {
    let midnight = date.and_time(NaiveTime::MIN);
    let Ok(zone) = tz.parse::<chrono_tz::Tz>() else { return midnight.and_utc() };
    for minutes in (0..=180).step_by(15) {
        if let Some(t) = zone.from_local_datetime(&(midnight + Duration::minutes(minutes))).earliest() {
            return t.with_timezone(&Utc);
        }
    }
    midnight.and_utc()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packages_load_with_the_platform() {
        let mut all = ferrum_domain::packages().expect("platform packages");
        all.extend(packages().expect("drive packages"));
        let catalog = ferrum_meta::Catalog::from_packages(all).expect("catalog");
        assert!(catalog.package("drive").is_some());
        assert!(MANIFEST.contains("packages: [drive]"));
    }

    #[test]
    fn days_start_at_local_midnight_across_daylight_saving() {
        let d = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let utc = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc);
        // New York leaves daylight saving on 2026-11-01: that day lasts 25 hours.
        assert_eq!(day_start("America/New_York", d("2026-11-01")), utc("2026-11-01T04:00:00Z"));
        assert_eq!(day_start("America/New_York", d("2026-11-02")), utc("2026-11-02T05:00:00Z"));
        // ... and enters it on 2026-03-08: 23 hours.
        assert_eq!(day_start("America/New_York", d("2026-03-08")), utc("2026-03-08T05:00:00Z"));
        assert_eq!(day_start("America/New_York", d("2026-03-09")), utc("2026-03-09T04:00:00Z"));
        assert_eq!(day_start("Asia/Kolkata", d("2026-06-01")), utc("2026-05-31T18:30:00Z"));
        assert_eq!(day_start("Not/AZone", d("2026-06-01")), utc("2026-06-01T00:00:00Z"));
        // Havana skipped midnight (00:00 → 01:00) on 2026-03-08: the day starts at 01:00 local.
        assert_eq!(day_start("America/Havana", d("2026-03-08")), utc("2026-03-08T05:00:00Z"));
    }
}

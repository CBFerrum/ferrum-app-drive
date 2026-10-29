//! Who may do what. A caller's access to an item is the highest of: their own space (Manage on
//! everything in it), their team-folder memberships, and shares to them or one of their roles on
//! the item or any folder above it (unexpired). Drive administrators — whoever may read every
//! Drive file through the generic API — manage everything.
//!
//! Every item carries its enclosing folders (`ancestors`, outermost first) and its top folder
//! (`root`, empty on top folders), so the level is computed from the item alone ([`Grants::level`])
//! and lists filter with one predicate built from the same grants ([`Grants::push_visible`]).
//! Nothing else in Drive decides access.

use ferrum_kernel::{Access, Action, Ctx, Result, Tx};
use sqlx::{Postgres, QueryBuilder};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    None,
    View,
    Comment,
    Edit,
    Manage,
}

impl Level {
    /// Share permissions (`View` … `Manage`).
    pub fn from_permission(s: &str) -> Option<Level> {
        Some(match s {
            "View" => Level::View,
            "Comment" => Level::Comment,
            "Edit" => Level::Edit,
            "Manage" => Level::Manage,
            _ => return None,
        })
    }

    /// Team-member roles (`Viewer` … `Manager`).
    pub fn from_role(s: &str) -> Option<Level> {
        Some(match s {
            "Viewer" => Level::View,
            "Commenter" => Level::Comment,
            "Editor" => Level::Edit,
            "Manager" => Level::Manage,
            _ => return None,
        })
    }

    pub fn as_int(self) -> i64 {
        self as i64
    }

    pub fn from_int(i: i64) -> Level {
        match i {
            1 => Level::View,
            2 => Level::Comment,
            3 => Level::Edit,
            4 => Level::Manage,
            _ => Level::None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Level::None => "None",
            Level::View => "View",
            Level::Comment => "Comment",
            Level::Edit => "Edit",
            Level::Manage => "Manage",
        }
    }
}

/// Whether the caller administers Drive: tenant administrators, the engine, and roles that read
/// every Drive file through the generic API (so Drive's own answers agree with that API).
pub fn is_admin(ctx: &Ctx) -> bool {
    ctx.is_admin || ctx.is_system || ctx.perms.access("DriveFile", Action::Read) == Access::All
}

/// The access a caller holds, loaded once per request.
#[derive(Debug, Clone, Default)]
pub struct Grants {
    pub admin: bool,
    /// The caller's email, lower-case.
    pub email: String,
    /// Top folders granted as a whole: the caller's own space (Manage) and team folders by role.
    pub roots: HashMap<Uuid, Level>,
    /// Files, and folders with everything in them, shared with the caller or one of their roles.
    pub shared: HashMap<Uuid, Level>,
}

impl Grants {
    pub async fn load(tx: &mut Tx, ctx: &Ctx) -> Result<Grants> {
        let email = ctx.email.trim().to_lowercase();
        if is_admin(ctx) {
            return Ok(Grants { admin: true, email, ..Default::default() });
        }
        let mut g = Grants { admin: false, email, ..Default::default() };
        let own: Vec<Uuid> = sqlx::query_scalar("select root_folder from e_drive_space where tenant_id = $1 and owner = $2 and root_folder is not null")
            .bind(ctx.tenant)
            .bind(&g.email)
            .fetch_all(&mut **tx)
            .await?;
        for r in own {
            g.roots.insert(r, Level::Manage);
        }
        let teams: Vec<(Uuid, String)> = sqlx::query_as(
            "select m.parent_id, m.role from e_drive_folder__members m join e_drive_folder f on f.tenant_id = m.tenant_id and f.id = m.parent_id \
             where m.tenant_id = $1 and m.member = $2 and f.is_team",
        )
        .bind(ctx.tenant)
        .bind(&g.email)
        .fetch_all(&mut **tx)
        .await?;
        for (team, role) in teams {
            g.grant_root(team, Level::from_role(&role).unwrap_or(Level::None));
        }
        let shares: Vec<(Uuid, i64)> = sqlx::query_as(
            "select coalesce(file, folder), coalesce(level, 0) from e_drive_share where tenant_id = $1 and (email = $2 or role = any($3)) \
             and (expires_at is null or expires_at > now())",
        )
        .bind(ctx.tenant)
        .bind(&g.email)
        .bind(&ctx.roles)
        .fetch_all(&mut **tx)
        .await?;
        for (item, level) in shares {
            let e = g.shared.entry(item).or_insert(Level::None);
            *e = (*e).max(Level::from_int(level));
        }
        Ok(g)
    }

    fn grant_root(&mut self, root: Uuid, level: Level) {
        let e = self.roots.entry(root).or_insert(Level::None);
        *e = (*e).max(level);
    }

    /// The caller's level on an item, from its id, top folder and enclosing folders.
    pub fn level(&self, id: Uuid, root: Option<Uuid>, ancestors: &[Uuid]) -> Level {
        if self.admin {
            return Level::Manage;
        }
        let top = root.unwrap_or(id);
        let mut level = self.roots.get(&top).copied().unwrap_or(Level::None);
        for x in ancestors.iter().chain(std::iter::once(&id)) {
            if let Some(s) = self.shared.get(x) {
                level = level.max(*s);
            }
        }
        level
    }

    /// ` and (...)` keeping the rows of alias `a` (with `id`, `root`, `ancestors`) the caller can
    /// see — exactly those whose [`Grants::level`] is at least View.
    pub fn push_visible(&self, qb: &mut QueryBuilder<Postgres>, a: &str) {
        if self.admin {
            return;
        }
        let roots: Vec<Uuid> = self.roots.iter().filter(|(_, l)| **l >= Level::View).map(|(id, _)| *id).collect();
        let shared: Vec<Uuid> = self.shared.iter().filter(|(_, l)| **l >= Level::View).map(|(id, _)| *id).collect();
        let direct: Vec<Uuid> = roots.iter().chain(shared.iter()).copied().collect();
        let under: Vec<String> = shared.iter().map(Uuid::to_string).collect();
        qb.push(format!(" and ({a}.root = any(")).push_bind(roots);
        qb.push(format!(") or {a}.id = any(")).push_bind(direct);
        qb.push(format!(") or {a}.ancestors ?| ")).push_bind(under).push("::text[])");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: usize) -> Vec<Uuid> {
        (0..n).map(|_| Uuid::now_v7()).collect()
    }

    #[test]
    fn levels_order_and_parse() {
        assert!(Level::Manage > Level::Edit && Level::Edit > Level::Comment && Level::Comment > Level::View && Level::View > Level::None);
        for l in [Level::View, Level::Comment, Level::Edit, Level::Manage] {
            assert_eq!(Level::from_int(l.as_int()), l);
            assert_eq!(Level::from_permission(l.name()), Some(l));
        }
        assert_eq!(Level::from_role("Editor"), Some(Level::Edit));
        assert_eq!(Level::from_permission("Owner"), None);
        assert_eq!(Level::from_int(9), Level::None);
    }

    #[test]
    fn access_is_inherited_down_the_tree_and_never_up() {
        // mine/ (my root) → a/ → b/ → file; team/ → t1/; shared/ (someone else's) → s1/ → s2/
        let [mine, a, b, file, team, t1, other, s1, s2] = ids(9).try_into().unwrap();
        let mut g = Grants { email: "me@x.test".into(), ..Default::default() };
        g.roots.insert(mine, Level::Manage);
        g.roots.insert(team, Level::View);
        g.shared.insert(s1, Level::Edit);
        g.shared.insert(t1, Level::Edit);
        assert_eq!(g.level(mine, None, &[]), Level::Manage);
        assert_eq!(g.level(file, Some(mine), &[mine, a, b]), Level::Manage);
        assert_eq!(g.level(team, None, &[]), Level::View);
        assert_eq!(g.level(t1, Some(team), &[team]), Level::Edit, "a share raises a team member's level below it");
        assert_eq!(g.level(file, Some(team), &[team, t1]), Level::Edit);
        assert_eq!(g.level(other, None, &[]), Level::None, "a share never grants the folders above it");
        assert_eq!(g.level(s1, Some(other), &[other]), Level::Edit);
        assert_eq!(g.level(s2, Some(other), &[other, s1]), Level::Edit);
        assert_eq!(g.level(file, Some(other), &[other]), Level::None, "a sibling of the shared folder stays private");
        let admin = Grants { admin: true, ..Default::default() };
        assert_eq!(admin.level(file, Some(other), &[other]), Level::Manage);
    }
}

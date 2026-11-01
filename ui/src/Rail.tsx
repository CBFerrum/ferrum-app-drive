// Drive's places: My files, what is shared with the person, recent, starred and the trash; the team
// folders they belong to, each with how full it is; and how much of their own space is used. Every
// place that is a folder takes drops, so items move there by dragging.

import { Clock, Folder, HardDrive, type LucideIcon, Plus, Settings2, Star, Trash2, Users } from "lucide-react";
import { Link } from "react-router";
import { Skeleton } from "@ferrum/kit/primitives";
import { allows } from "./files";
import { useDropTarget } from "./dropping";
import { type View, VIEWS } from "./listing";
import { Meter } from "./Meter";
import { type Usage, leftLabel, spaceLabel, toneOf } from "./usage";

const ICONS: Record<View, LucideIcon> = { mine: HardDrive, shared: Users, recent: Clock, starred: Star, trash: Trash2 };

/** Where the person is: one of the views, or a team folder. */
export type Place = View | { team: string } | null;

type Team = Usage["teams"][number];

function Entry({ to, current, drop, onPick, children }: { to: string; current: boolean; drop?: { id: string; name: string; permission?: string }; onPick: () => void; children: React.ReactNode }) {
  const target = useDropTarget(drop ?? null);
  return (
    <Link to={to} className="drive-place" aria-current={current ? "page" : undefined} data-over={target.over || undefined} onClick={onPick} {...target.props}>
      {children}
    </Link>
  );
}

export function Rail({
  place,
  usage,
  loading,
  root,
  onPick,
  onManage,
  onNewTeam,
  className,
  id,
}: {
  place: Place;
  usage: Usage | undefined;
  /** The storage is still being asked for. */
  loading: boolean;
  /** The person's top folder, where a drop on My files goes. */
  root: string | undefined;
  /** A place was chosen (on a phone, the rail closes). */
  onPick: () => void;
  onManage: (team: Team) => void;
  onNewTeam: () => void;
  className?: string;
  id?: string;
}) {
  const teams = usage?.teams ?? [];
  const mine = usage ? { used: usage.space.used_bytes, quota: usage.space.quota_bytes } : null;
  const tone = mine ? toneOf(mine) : "ok";
  return (
    <nav id={id} className={`drive-rail ${className ?? ""}`} aria-label="Places">
      <ul className="drive-places">
        {VIEWS.map((v) => {
          const Icon = ICONS[v.id];
          return (
            <li key={v.id}>
              <Entry to={v.id === "mine" ? "/drive" : `/drive?view=${v.id}`} current={place === v.id} drop={v.id === "mine" && root ? { id: root, name: "My files", permission: "Manage" } : undefined} onPick={onPick}>
                <Icon aria-hidden size={16} />
                <span>{v.label}</span>
              </Entry>
            </li>
          );
        })}
      </ul>
      {(teams.length > 0 || usage?.admin) && (
        <>
          <div className="drive-rail-head">
            <h2>Team folders</h2>
            {usage?.admin && (
              <button type="button" className="drive-rail-add" onClick={onNewTeam} aria-label="New team folder" title="New team folder">
                <Plus aria-hidden size={14} />
              </button>
            )}
          </div>
          <ul className="drive-places">
            {teams.map((t) => (
              <li key={t.id} className="drive-team">
                <Entry to={`/drive/${t.id}`} current={typeof place === "object" && place?.team === t.id} drop={{ id: t.id, name: t.name, permission: t.permission }} onPick={onPick}>
                  <Folder aria-hidden size={16} />
                  <span className="drive-team-name">
                    {t.name}
                    <Meter space={{ used: t.used_bytes, quota: t.quota_bytes }} label={`Space used by ${t.name}`} thin />
                  </span>
                </Entry>
                {allows(t.permission, "Manage") && (
                  <button type="button" className="drive-rail-add" onClick={() => onManage(t)} aria-label={`Members and space of ${t.name}`} title="Members and space">
                    <Settings2 aria-hidden size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="drive-storage">
        {mine ? (
          <>
            <div className="drive-storage-head">
              <span>Your storage</span>
              <span className="faint">{spaceLabel(mine)}</span>
            </div>
            <Meter space={mine} label="Your storage" />
            {tone !== "ok" && (
              <p className="drive-storage-note" data-tone={tone}>
                {leftLabel(mine)}. Empty the trash, or ask an administrator for more.
              </p>
            )}
          </>
        ) : (
          loading && <Skeleton className="h-8 motion-reduce:animate-none" />
        )}
      </div>
    </nav>
  );
}

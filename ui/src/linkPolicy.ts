// Public links and the workspace's rules for them: what the server asks of a new link (it checks
// every one again), what each link of an item has and how it stands, and what to say before a
// link is refused rather than after. Pure, so it is tested without a browser.

import { daysAgo } from "./listing";
import { t } from "@ferrum/client";

/** What `list_links` says the workspace requires. */
export interface LinkPolicy {
  allow_public_links: boolean;
  /** Every link must end within this many days; 0 lets links last for ever. */
  max_link_days: number;
  link_password_required: boolean;
}

/** Until the server has answered: the workspace's defaults. */
export const OPEN_POLICY: LinkPolicy = { allow_public_links: true, max_link_days: 0, link_password_required: false };

export interface PublicLink {
  id: string;
  access: string;
  has_password: boolean;
  expires_at?: string | null;
  max_downloads?: number | null;
  download_count?: number;
  last_accessed_at?: string | null;
  created_at?: string;
  revoked?: boolean;
  active?: boolean;
  /** The guest it was sent to; none for a link anyone may hold. */
  email?: string | null;
  note?: string | null;
  /** Its maker's (it goes with them when they leave) or the workspace's (it stays). */
  belongs_to?: "Its Maker" | "The Workspace";
  /** Who answers for a link of the workspace's. */
  answerable?: string | null;
  /** Whose leaving it went through, and what became of it then. */
  left_by?: string | null;
  on_leaving?: "Stayed" | "Passed On" | "Stopped" | "Kept" | null;
  left_at?: string | null;
}

/** What a person fills in for a new link. Dates are `YYYY-MM-DD`. */
export interface LinkDraft {
  access: "View" | "Download";
  expires: string;
  password: string;
  limit: string;
  note: string;
  /** Someone of the workspace who answers for it, which makes it the workspace's; empty: its maker's. */
  answerable: string;
}

export const NOTE_MAX = 280;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;

/** The last day a link may end on. A day means its end in the workspace's time zone, so a link that
 *  may last 7 days ends on the sixth day after today at the latest. */
export const latestEnd = (p: LinkPolicy, today: string): string | null => (p.max_link_days > 0 ? daysAgo(today, -(p.max_link_days - 1)) : null);

/** A fresh form: the longest the rules allow when they ask for an end, else no end. */
export function blankDraft(p: LinkPolicy, today: string): LinkDraft {
  return { access: "View", expires: latestEnd(p, today) ?? "", password: "", limit: "", note: "", answerable: "" };
}

/** The rules in a sentence, or none when there are none to tell. */
export function rules(p: LinkPolicy): string | null {
  if (!p.allow_public_links) return null;
  const asks: string[] = [];
  if (p.link_password_required) asks.push(t("need a password"));
  if (p.max_link_days > 0) asks.push((p.max_link_days === 1 ? t("end within a day") : t("end within {days} days", { days: Number(p.max_link_days) })));
  return asks.length ? t("Links in this workspace {asks}.", { asks: asks.join(" and ") }) : null;
}

export type Problems = Partial<Record<keyof LinkDraft, string>>;

/** What is wrong with a draft, by field: what the server would refuse, caught first. */
export function problems(d: LinkDraft, p: LinkPolicy, today: string): Problems {
  const out: Problems = {};
  const latest = latestEnd(p, today);
  if (latest && !d.expires) out.expires = t("Pick the day the link ends");
  else if (d.expires && d.expires <= daysAgo(today, 1)) out.expires = t("Pick a day that has not passed");
  else if (latest && d.expires > latest) out.expires = t("The latest is {latest}", { latest });
  if (p.link_password_required && !d.password) out.password = t("This workspace needs a password on links");
  else if (d.password && (d.password.length < PASSWORD_MIN || d.password.length > PASSWORD_MAX)) out.password = t("Use {PASSWORD_MIN} to {PASSWORD_MAX} characters", { PASSWORD_MIN, PASSWORD_MAX });
  if (d.limit && !/^[1-9]\d{0,8}$/.test(d.limit.trim())) out.limit = t("Use a whole number, or leave it empty");
  if (d.note.length > NOTE_MAX) out.note = t("At most {NOTE_MAX} characters", { NOTE_MAX });
  if (d.answerable.trim() && !/^\S+@\S+\.\S+$/.test(d.answerable.trim())) out.answerable = t("Pick someone of this workspace");
  return out;
}

/** The parameters of `create_link` for a draft; what is empty is left out. */
export function linkBody(item: string, d: LinkDraft): Record<string, unknown> {
  return {
    item,
    access: d.access,
    expires_at: d.expires || undefined,
    password: d.password || undefined,
    max_downloads: d.limit.trim() ? Number(d.limit) : undefined,
    note: d.note.trim() || undefined,
    answerable: d.answerable.trim() || undefined,
  };
}

/** What became of a link when someone left, in a sentence; none if nobody has. */
export function departure(l: PublicLink, name: (email: string) => string): string | null {
  if (!l.left_by || !l.on_leaving) return null;
  const who = name(l.left_by);
  switch (l.on_leaving) {
    case "Stayed":
      return t("Stayed when {who} left: it is the workspace's", { who });
    case "Passed On":
      return t("Passed on when {who} left", { who });
    case "Stopped":
      return t("Stopped when {who} left: nobody took over", { who });
    case "Kept":
      return t("Kept when {who} left, as the workspace keeps such links", { who });
  }
}

export type LinkState = "active" | "ended" | "used up" | "off";

/** How a link stands. */
export function stateOf(l: PublicLink, now = Date.now()): LinkState {
  if (l.revoked) return "off";
  if (l.expires_at && Date.parse(l.expires_at) <= now) return "ended";
  if (l.max_downloads && (l.download_count ?? 0) >= l.max_downloads) return "used up";
  return "active";
}

/** A password that is easy to read out and hard to guess: no letters that look like others. */
export function makePassword(random: (n: number) => number[], length = 14): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return random(length)
    .map((n) => alphabet[n % alphabet.length])
    .join("");
}

// Public links and the workspace's rules for them: what the server asks of a new link (it checks
// every one again), what each link of an item has and how it stands, and what to say before a
// link is refused rather than after. Pure, so it is tested without a browser.

import { daysAgo } from "./listing";

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
}

/** What a person fills in for a new link. Dates are `YYYY-MM-DD`. */
export interface LinkDraft {
  access: "View" | "Download";
  expires: string;
  password: string;
  limit: string;
  note: string;
}

export const NOTE_MAX = 280;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;

/** The last day a link may end on. A day means its end in the workspace's time zone, so a link that
 *  may last 7 days ends on the sixth day after today at the latest. */
export const latestEnd = (p: LinkPolicy, today: string): string | null => (p.max_link_days > 0 ? daysAgo(today, -(p.max_link_days - 1)) : null);

/** A fresh form: the longest the rules allow when they ask for an end, else no end. */
export function blankDraft(p: LinkPolicy, today: string): LinkDraft {
  return { access: "View", expires: latestEnd(p, today) ?? "", password: "", limit: "", note: "" };
}

/** The rules in a sentence, or none when there are none to tell. */
export function rules(p: LinkPolicy): string | null {
  if (!p.allow_public_links) return null;
  const asks: string[] = [];
  if (p.link_password_required) asks.push("need a password");
  if (p.max_link_days > 0) asks.push(`end within ${p.max_link_days === 1 ? "a day" : `${p.max_link_days} days`}`);
  return asks.length ? `Links in this workspace ${asks.join(" and ")}.` : null;
}

export type Problems = Partial<Record<keyof LinkDraft, string>>;

/** What is wrong with a draft, by field: what the server would refuse, caught first. */
export function problems(d: LinkDraft, p: LinkPolicy, today: string): Problems {
  const out: Problems = {};
  const latest = latestEnd(p, today);
  if (latest && !d.expires) out.expires = "Pick the day the link ends";
  else if (d.expires && d.expires <= daysAgo(today, 1)) out.expires = "Pick a day that has not passed";
  else if (latest && d.expires > latest) out.expires = `The latest is ${latest}`;
  if (p.link_password_required && !d.password) out.password = "This workspace needs a password on links";
  else if (d.password && (d.password.length < PASSWORD_MIN || d.password.length > PASSWORD_MAX)) out.password = `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`;
  if (d.limit && !/^[1-9]\d{0,8}$/.test(d.limit.trim())) out.limit = "Use a whole number, or leave it empty";
  if (d.note.length > NOTE_MAX) out.note = `At most ${NOTE_MAX} characters`;
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
  };
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

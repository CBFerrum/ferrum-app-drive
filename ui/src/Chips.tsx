// The sort and the filters above a list, as chips: each shows what it is set to, and the page keeps
// them in its address. Where the server cannot sort or filter a list, its chips are not offered.

import { ArrowDownUp, Calendar, FolderSearch, Shapes, User, X } from "lucide-react";
import { Suspense, lazy } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ferrum/kit/primitives";
import { Chip } from "./Chip";
import { type Order, type Query, SINCE, SORTS, type Source, TYPES, abilities, defaultSort, filtersOn, naturalOrder } from "./listing";
import { t as tr, isolate } from "@ferrum/client";

const OwnerChip = lazy(() => import("./OwnerChip"));

/** How each sort's two directions read. */
const WAYS: Record<string, [string, string]> = {
  get name(): [string, string] { return [tr("A to Z"), tr("Z to A")]; },
  type: ["A to Z", "Z to A"],
  get modified(): [string, string] { return [tr("Oldest first"), tr("Newest first")]; },
  get size(): [string, string] { return [tr("Smallest first"), tr("Largest first")]; },
};

/** The chip changes the address: a value of null takes its key out. */
export type SetQuery = (next: Partial<Record<keyof Query | "in", string | null>>) => void;

/** Where a search looks: everywhere, or inside one folder (`name` is its name once known). Only a search offers it. */
export interface Location {
  name: string | null;
  choose: () => void;
}

export function Chips({ src, fileType, q, set, location }: { src: Source | null; fileType?: string; q: Query; set: SetQuery; location?: Location | null }) {
  const can = abilities(src, fileType);
  const sort = q.sort ?? defaultSort(src);
  const order: Order = q.order ?? (sort ? naturalOrder(sort) : "asc");
  const type = TYPES.find((t) => t.id === q.type);
  const since = SINCE.find((s) => s.days === q.since);
  if (!can.sorts.length && !can.filter) return null;

  return (
    <div className="drive-chips" role="group" aria-label={tr("Sort and filter")}>
      {can.sorts.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Chip icon={ArrowDownUp} label={sort ? tr("Sort: {label}{value}", { label: String(SORTS.find((s) => s.id === sort)?.label), value: can.direction ? (order === "desc" ? " ↓" : " ↑") : "" }) : tr("Sort")} on={!!q.sort} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuLabel>{tr("Sort by")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sort ?? ""} onValueChange={(v) => set({ sort: v, order: null })}>
              {SORTS.filter((s) => can.sorts.includes(s.id)).map((s) => (
                <DropdownMenuRadioItem key={s.id} value={s.id}>
                  {isolate(s.label)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {can.direction && sort && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={order} onValueChange={(v) => set({ sort, order: v })}>
                  <DropdownMenuRadioItem value="asc">{isolate(WAYS[sort][0])}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="desc">{isolate(WAYS[sort][1])}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {can.filter && can.type && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Chip icon={Shapes} label={type ? tr("Type: {label}", { label: type.label }) : tr("Type")} on={!!type} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuRadioGroup value={q.type ?? ""} onValueChange={(v) => set({ type: v || null })}>
              <DropdownMenuRadioItem value="">{tr("Any type")}</DropdownMenuRadioItem>
              {TYPES.map((t) => (
                <DropdownMenuRadioItem key={t.id} value={t.id}>
                  {isolate(t.label)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {can.filter && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Chip icon={Calendar} label={since ? tr("Modified: {label}", { label: since.label }) : tr("Modified")} on={!!since} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuRadioGroup value={q.since ? String(q.since) : ""} onValueChange={(v) => set({ since: v || null })}>
              <DropdownMenuRadioItem value="">{tr("Any time")}</DropdownMenuRadioItem>
              {SINCE.map((s) => (
                <DropdownMenuRadioItem key={s.days} value={String(s.days)}>
                  {isolate(s.label)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {can.filter && location && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Chip icon={FolderSearch} label={q.within ? tr("In: {value}", { value: location.name ?? tr("a folder") }) : tr("Location")} on={!!q.within} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuRadioGroup value={q.within ? "in" : ""} onValueChange={(v) => !v && set({ in: null })}>
              <DropdownMenuRadioItem value="">{tr("Anywhere in Drive")}</DropdownMenuRadioItem>
              {q.within && <DropdownMenuRadioItem value="in">{isolate(tr("In {value}", { value: location.name ?? tr("a folder") }))}</DropdownMenuRadioItem>}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={location.choose}>{tr("Choose a folder…")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {can.filter && (
        <Suspense fallback={<Chip icon={User} label={q.owner ? tr("Owner: {value}", { value: q.owner }) : tr("Owner")} on={!!q.owner} disabled />}>
          <OwnerChip owner={q.owner} set={set} />
        </Suspense>
      )}
      {filtersOn(q) > 0 && (
        <button type="button" className="drive-chip-clear" onClick={() => set({ type: null, since: null, owner: null, in: null })}>
          <X aria-hidden size={13} /> {tr("Clear filters")}
        </button>
      )}
    </div>
  );
}

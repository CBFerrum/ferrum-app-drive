// The sort and the filters above a list, as chips: each shows what it is set to, and the page keeps
// them in its address. Where the server cannot sort or filter a list, its chips are not offered.

import { ArrowDownUp, Calendar, ChevronDown, Shapes, User, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { usePeople } from "@ferrum/records";
import { Button } from "@ferrum/kit";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@ferrum/kit/primitives";
import { type Order, type Query, SINCE, SORTS, type Source, TYPES, abilities, defaultSort, filtersOn, naturalOrder } from "./listing";

/** How each sort's two directions read. */
const WAYS: Record<string, [string, string]> = {
  name: ["A to Z", "Z to A"],
  type: ["A to Z", "Z to A"],
  modified: ["Oldest first", "Newest first"],
  size: ["Smallest first", "Largest first"],
};

/** The chip changes the address: a value of null takes its key out. */
export type SetQuery = (next: Partial<Record<keyof Query, string | null>>) => void;

function Chip({ icon: Icon, label, on, ...rest }: { icon: typeof Shapes; label: string; on?: boolean } & React.ComponentProps<"button">) {
  return (
    <button type="button" className="drive-chip" data-on={on || undefined} {...rest}>
      <Icon aria-hidden size={14} />
      <span>{label}</span>
      <ChevronDown aria-hidden size={13} />
    </button>
  );
}

export function Chips({ src, fileType, q, set }: { src: Source | null; fileType?: string; q: Query; set: SetQuery }) {
  const can = abilities(src, fileType);
  const people = usePeople().data?.users ?? [];
  const field = useId();
  const [owner, setOwner] = useState(q.owner ?? "");
  const sort = q.sort ?? defaultSort(src);
  const order: Order = q.order ?? (sort ? naturalOrder(sort) : "asc");
  const type = TYPES.find((t) => t.id === q.type);
  const since = SINCE.find((s) => s.days === q.since);
  const named = people.find((p) => p.email.toLowerCase() === q.owner);
  if (!can.sorts.length && !can.filter) return null;

  const ask = (e: FormEvent) => {
    e.preventDefault();
    set({ owner: owner.trim().toLowerCase() || null });
  };

  return (
    <div className="drive-chips" role="group" aria-label="Sort and filter">
      {can.sorts.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Chip icon={ArrowDownUp} label={sort ? `Sort: ${SORTS.find((s) => s.id === sort)?.label}${can.direction ? (order === "desc" ? " ↓" : " ↑") : ""}` : "Sort"} on={!!q.sort} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sort ?? ""} onValueChange={(v) => set({ sort: v, order: null })}>
              {SORTS.filter((s) => can.sorts.includes(s.id)).map((s) => (
                <DropdownMenuRadioItem key={s.id} value={s.id}>
                  {s.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {can.direction && sort && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={order} onValueChange={(v) => set({ sort, order: v })}>
                  <DropdownMenuRadioItem value="asc">{WAYS[sort][0]}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="desc">{WAYS[sort][1]}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {can.filter && can.type && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Chip icon={Shapes} label={type ? `Type: ${type.label}` : "Type"} on={!!type} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuRadioGroup value={q.type ?? ""} onValueChange={(v) => set({ type: v || null })}>
              <DropdownMenuRadioItem value="">Any type</DropdownMenuRadioItem>
              {TYPES.map((t) => (
                <DropdownMenuRadioItem key={t.id} value={t.id}>
                  {t.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {can.filter && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Chip icon={Calendar} label={since ? `Modified: ${since.label}` : "Modified"} on={!!since} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuRadioGroup value={q.since ? String(q.since) : ""} onValueChange={(v) => set({ since: v || null })}>
              <DropdownMenuRadioItem value="">Any time</DropdownMenuRadioItem>
              {SINCE.map((s) => (
                <DropdownMenuRadioItem key={s.days} value={String(s.days)}>
                  {s.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {can.filter && (
        <Popover onOpenChange={(open) => open && setOwner(q.owner ?? "")}>
          <PopoverTrigger asChild>
            <Chip icon={User} label={q.owner ? `Owner: ${named?.full_name || q.owner}` : "Owner"} on={!!q.owner} />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72">
            <form onSubmit={ask} className="grid gap-2">
              <label htmlFor={field} className="text-sm font-medium">
                Files owned by
              </label>
              <input id={field} className="input" type="email" list={`${field}-people`} placeholder="name@company.com" value={owner} onChange={(e) => setOwner(e.target.value)} autoComplete="off" />
              <datalist id={`${field}-people`}>
                {people.map((p) => (
                  <option key={p.id} value={p.email}>
                    {p.full_name}
                  </option>
                ))}
              </datalist>
              <div className="flex justify-end gap-2">
                {q.owner && (
                  <Button size="sm" onClick={() => (setOwner(""), set({ owner: null }))}>
                    Clear
                  </Button>
                )}
                <Button size="sm" variant="primary" type="submit" disabled={!owner.trim()}>
                  Apply
                </Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
      )}
      {filtersOn(q) > 0 && (
        <button type="button" className="drive-chip-clear" onClick={() => set({ type: null, since: null, owner: null })}>
          <X aria-hidden size={13} /> Clear filters
        </button>
      )}
    </div>
  );
}

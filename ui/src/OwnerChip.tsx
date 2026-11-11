// The Owner chip: a person's address (or one picked from the workspace's people) asked for in a
// popover. Loaded after the other chips, since it brings the people list with it.

import { User } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { usePeople } from "@ferrum/records";
import { Button } from "@ferrum/kit";
import { Popover, PopoverContent, PopoverTrigger } from "@ferrum/kit/primitives";
import { t as tr, isolate } from "@ferrum/client";
import { Chip } from "./Chip";
import type { SetQuery } from "./Chips";

export default function OwnerChip({ owner: current, set }: { owner: string | null; set: SetQuery }) {
  const people = usePeople().data?.users ?? [];
  const field = useId();
  const [owner, setOwner] = useState(current ?? "");
  const named = people.find((p) => p.email.toLowerCase() === current);
  const ask = (e: FormEvent) => {
    e.preventDefault();
    set({ owner: owner.trim().toLowerCase() || null });
  };
  return (
    <Popover onOpenChange={(open) => open && setOwner(current ?? "")}>
      <PopoverTrigger asChild>
        <Chip icon={User} label={current ? tr("Owner: {value}", { value: named?.full_name || current }) : tr("Owner")} on={!!current} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <form onSubmit={ask} className="grid gap-2">
          <label htmlFor={field} className="text-sm font-medium">
            {tr("Files owned by")}
          </label>
          <input id={field} className="input" type="email" list={`${field}-people`} placeholder={tr("name@company.com")} value={owner} onChange={(e) => setOwner(e.target.value)} autoComplete="off" />
          <datalist id={`${field}-people`}>
            {people.map((p) => (
              <option key={p.id} value={p.email}>
                {isolate(p.full_name)}
              </option>
            ))}
          </datalist>
          <div className="flex justify-end gap-2">
            {current && (
              <Button size="sm" onClick={() => (setOwner(""), set({ owner: null }))}>
                {tr("Clear")}
              </Button>
            )}
            <Button size="sm" variant="primary" type="submit" disabled={!owner.trim()}>
              {tr("Apply")}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

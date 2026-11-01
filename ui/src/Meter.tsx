// A bar showing how much of its space something uses: amber near the limit, red at it. With no
// limit there is no bar, only what is used.

import { type Space, fullness, spaceLabel, toneOf } from "./usage";

export function Meter({ space, label, thin }: { space: Space; label: string; thin?: boolean }) {
  const filled = fullness(space);
  if (filled === null) return null;
  return (
    <span
      className="drive-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={space.quota ?? undefined}
      aria-valuenow={Math.min(space.used, space.quota ?? space.used)}
      aria-valuetext={spaceLabel(space)}
      data-tone={toneOf(space)}
      data-thin={thin || undefined}
    >
      <span style={{ width: `${Math.max(filled * 100, space.used > 0 ? 2 : 0)}%` }} />
    </span>
  );
}

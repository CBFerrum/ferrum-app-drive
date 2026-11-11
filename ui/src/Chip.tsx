// One chip above the list: an icon, what it is set to, and a chevron.

import { ChevronDown, type LucideIcon } from "lucide-react";
import { isolate } from "@ferrum/client";

export function Chip({ icon: Icon, label, on, ...rest }: { icon: LucideIcon; label: string; on?: boolean } & React.ComponentProps<"button">) {
  return (
    <button type="button" className="drive-chip" data-on={on || undefined} {...rest}>
      <Icon aria-hidden size={14} />
      <span>{isolate(label)}</span>
      <ChevronDown aria-hidden size={13} />
    </button>
  );
}

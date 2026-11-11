// An item's menu button, there at once; the menu itself (and the menu machinery) loads just after the page.

import { MoreHorizontal } from "lucide-react";
import { Suspense, lazy, type ComponentProps } from "react";
import { t as tr } from "@ferrum/client";
import { Button as UiButton } from "@ferrum/kit/primitives";
import { shownName } from "./files";

const Menu = lazy(() => import("./ItemMenu").then((m) => ({ default: m.ItemMenu })));

export function ItemMenuLater(props: ComponentProps<typeof Menu>) {
  return (
    <Suspense
      fallback={
        <UiButton variant="ghost" size="icon-sm" disabled aria-label={tr("More for {name}", { name: shownName(props.it.name) })} className="text-muted-foreground">
          <MoreHorizontal />
        </UiButton>
      }
    >
      <Menu {...props} />
    </Suspense>
  );
}

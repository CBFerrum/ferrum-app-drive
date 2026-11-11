// A toast that can be taken back: "Moved 3 items to “Reports”. Undo". It stays a while, longer while
// the pointer or the keyboard is on it, and Undo does the opposite and says how that went.

import { Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, t as tr, isolate } from "@ferrum/client";
import { toast } from "@ferrum/kit";

interface Offer {
  id: number;
  message: string;
  undo: () => Promise<string>;
}

const STAYS = 10_000;

/** `offer(message, undo)` shows the toast; `undo` returns what to say when it is done. Render `host` once. */
export function useUndo() {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const holding = useRef(false);
  const arm = useCallback((id: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => (holding.current ? arm(id) : setOffer((o) => (o?.id === id ? null : o))), STAYS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const give = useCallback(
    (message: string, undo: () => Promise<string>) => {
      const id = ++seq.current;
      setOffer({ id, message, undo });
      arm(id);
    },
    [arm],
  );
  const take = async () => {
    if (!offer || busy) return;
    setBusy(true);
    const { undo } = offer;
    setOffer(null);
    try {
      toast(await undo());
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const host = offer && (
    <div className="drive-undo" role="status" onMouseEnter={() => (holding.current = true)} onMouseLeave={() => (holding.current = false)} onFocus={() => (holding.current = true)} onBlur={() => (holding.current = false)}>
      <span className="drive-undo-message">{isolate(offer.message)}</span>
      <button type="button" className="drive-undo-button" onClick={() => void take()}>
        <Undo2 aria-hidden size={14} /> {tr("Undo")}
      </button>
    </div>
  );
  return { give, host };
}

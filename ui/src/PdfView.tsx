// A PDF drawn in the page (pdf.js, loaded only when a PDF is opened): pages drawn as they come into
// view, with their text selectable, page numbers, zoom and a search through the document's words.
// The browser's own viewer is no longer what opens a PDF in Drive.

import { ChevronDown, ChevronUp, Minus, Plus, Search, X } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t as tr } from "@ferrum/client";
import { Button as UiButton } from "@ferrum/kit/primitives";
import { Spinner } from "@ferrum/kit";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Doc = pdfjs.PDFDocumentProxy;

/** One page: a box of the page's size that draws itself (canvas and selectable text) when it is near the screen. */
function Page({ doc, no, scale, size, hits, onSize }: { doc: Doc; no: number; scale: number; size: [number, number]; hits: string; onSize: (no: number, wh: [number, number]) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return setNear(true);
    const watch = new IntersectionObserver((seen) => setNear(seen.some((s) => s.isIntersecting)), { rootMargin: "800px 0px" });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    if (!near) return;
    let task: pdfjs.RenderTask | undefined;
    let layer: pdfjs.TextLayer | undefined;
    let gone = false;
    void doc.getPage(no).then(async (page) => {
      const el = canvas.current;
      const over = text.current;
      if (gone || !el || !over) return;
      const view = page.getViewport({ scale });
      onSize(no, [view.width / scale, view.height / scale]);
      const ratio = window.devicePixelRatio || 1;
      el.width = Math.floor(view.width * ratio);
      el.height = Math.floor(view.height * ratio);
      task = page.render({ canvas: el, viewport: view, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      over.replaceChildren();
      layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: over, viewport: view });
      try {
        await Promise.all([task.promise, layer.render()]);
        if (!gone) mark(over, hits);
      } catch {
        // Cancelled by a zoom or by leaving: nothing to say.
      }
    });
    return () => {
      gone = true;
      task?.cancel();
      layer?.cancel();
    };
    // The words found are marked by the next effect, not by drawing the page again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, doc, no, scale]);
  useEffect(() => {
    if (text.current) mark(text.current, hits);
  }, [hits]);
  return (
    <div
      ref={box}
      className="drive-pdf-page"
      data-page={no}
      style={{ inlineSize: size[0] * scale, blockSize: size[1] * scale, ["--scale-factor" as string]: scale, ["--total-scale-factor" as string]: scale, ["--scale-round-x" as string]: "1px", ["--scale-round-y" as string]: "1px" }}
    >
      <canvas ref={canvas} aria-label={tr("Page {no}", { no })} style={{ inlineSize: "100%", blockSize: "100%" }} />
      <div ref={text} className="drive-pdf-text" />
    </div>
  );
}

/** Marks the words of a page's text that hold the search words. */
function mark(layer: HTMLElement, words: string) {
  const w = words.toLowerCase();
  for (const span of layer.querySelectorAll<HTMLElement>("span")) span.toggleAttribute("data-hit", !!w && (span.textContent ?? "").toLowerCase().includes(w));
}

export default function PdfView({ url, onFail }: { url: string; onFail: (why: "password" | "broken") => void }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [sizes, setSizes] = useState<Record<number, [number, number]>>({});
  const [zoom, setZoom] = useState<number | "width">("width");
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const [asked, setAsked] = useState("");
  const [typed, setTyped] = useState("");
  const [found, setFound] = useState<{ pages: number[]; at: number; looking: boolean } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const texts = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    const task = pdfjs.getDocument({ url, withCredentials: true });
    let gone = false;
    task.promise.then(
      (d) => !gone && setDoc(d),
      (e: unknown) => !gone && onFail((e as { name?: string })?.name === "PasswordException" ? "password" : "broken"),
    );
    return () => {
      gone = true;
      void task.destroy();
    };
  }, [url, onFail]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, [doc]);
  // Page 1's size stands for the rest until each says its own.
  const first = sizes[1] ?? ([612, 792] as [number, number]);
  const scale = zoom === "width" ? Math.max(0.4, Math.min(1.5, (width - 32) / first[0] || 1)) : zoom;
  const onSize = useCallback((no: number, wh: [number, number]) => setSizes((s) => (s[no] && Math.abs(s[no][0] - wh[0]) < 0.5 && Math.abs(s[no][1] - wh[1]) < 0.5 ? s : { ...s, [no]: wh })), []);
  const zoomBy = (f: number) => setZoom(Math.max(0.4, Math.min(4, +(scale * f).toFixed(2))));

  // The page nearest the top of the view is the one the number shows.
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + 24;
    let best = 1;
    for (const p of el.querySelectorAll<HTMLElement>("[data-page]")) {
      if (p.getBoundingClientRect().top <= top + p.offsetHeight / 3) best = Number(p.dataset.page);
      else break;
    }
    setCurrent(best);
  };
  const go = (no: number) => {
    if (!doc) return;
    const n = Math.max(1, Math.min(doc.numPages, no));
    scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`)?.scrollIntoView({ block: "start" });
    setCurrent(n);
  };

  const search = async (e: FormEvent) => {
    e.preventDefault();
    const word = typed.trim();
    setAsked(word);
    if (!word || !doc) return setFound(null);
    setFound({ pages: [], at: 0, looking: true });
    const pages: number[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      let text = texts.current.get(n);
      if (text === undefined) {
        const content = await (await doc.getPage(n)).getTextContent();
        text = content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
        texts.current.set(n, text);
      }
      if (text.toLowerCase().includes(word.toLowerCase())) pages.push(n);
    }
    setFound({ pages, at: 0, looking: false });
    if (pages[0]) go(pages[0]);
  };
  const step = (by: number) => {
    if (!found?.pages.length) return;
    const at = (found.at + by + found.pages.length) % found.pages.length;
    setFound({ ...found, at });
    go(found.pages[at]);
  };

  const pages = useMemo(() => (doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : []), [doc]);
  if (!doc) return <div className="drive-preview-wait"><Spinner label={tr("Opening the PDF")} /></div>;
  return (
    <div className="drive-pdf">
      <div className="drive-pdf-bar" role="toolbar" aria-label={tr("PDF controls")}>
        <label className="drive-pdf-page-box">
          <span className="sr-only">{tr("Page")}</span>
          <input
            className="input"
            inputMode="numeric"
            value={current}
            aria-label={tr("Page number")}
            onChange={(e) => /^\d*$/.test(e.target.value) && e.target.value && go(Number(e.target.value))}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <span aria-hidden="true">{tr("of {n}", { n: doc.numPages })}</span>
        </label>
        <span className="drive-pdf-sep" aria-hidden="true" />
        <UiButton variant="ghost" size="icon-sm" aria-label={tr("Zoom out")} onClick={() => zoomBy(1 / 1.25)}>
          <Minus />
        </UiButton>
        <button type="button" className="drive-pdf-zoom" aria-label={tr("Fit to width")} title={tr("Fit to width")} onClick={() => setZoom("width")}>
          {Math.round(scale * 100)}%
        </button>
        <UiButton variant="ghost" size="icon-sm" aria-label={tr("Zoom in")} onClick={() => zoomBy(1.25)}>
          <Plus />
        </UiButton>
        <span className="drive-pdf-sep" aria-hidden="true" />
        <form className="drive-pdf-find" role="search" onSubmit={(e) => void search(e)}>
          <Search aria-hidden size={14} />
          <input className="input" type="search" placeholder={tr("Find in the document")} aria-label={tr("Find in the document")} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </form>
        {found && (
          <span className="drive-pdf-count" role="status">
            {found.looking ? tr("Searching…") : found.pages.length ? tr("Page {no}, {at} of {n} pages", { no: found.pages[found.at], at: found.at + 1, n: found.pages.length }) : tr("Not found")}
          </span>
        )}
        {found && !found.looking && found.pages.length > 1 && (
          <>
            <UiButton variant="ghost" size="icon-sm" aria-label={tr("Previous match")} onClick={() => step(-1)}>
              <ChevronUp />
            </UiButton>
            <UiButton variant="ghost" size="icon-sm" aria-label={tr("Next match")} onClick={() => step(1)}>
              <ChevronDown />
            </UiButton>
          </>
        )}
        {found && (
          <UiButton variant="ghost" size="icon-sm" aria-label={tr("Clear the search")} onClick={() => (setFound(null), setAsked(""), setTyped(""))}>
            <X />
          </UiButton>
        )}
      </div>
      <div ref={scroller} className="drive-pdf-scroll" tabIndex={0} role="region" aria-label={tr("Pages")} onScroll={onScroll}>
        {pages.map((no) => (
          <Page key={`${no}`} doc={doc} no={no} scale={scale} size={sizes[no] ?? first} hits={asked} onSize={onSize} />
        ))}
      </div>
    </div>
  );
}

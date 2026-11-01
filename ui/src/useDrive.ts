// What Drive's screens ask the server for, as hooks: the person's space and storage, a folder's own
// details, and the pages of a list (a folder, a search, a view), which load as the person scrolls.

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { api, todayIso } from "@ferrum/client";
import { useLiveEntity } from "@ferrum/kit";
import type { Crumb, Item } from "./files";
import { type Query, type Source, VIEWS, filterItems, flatten, naturalOrder, nextOffset, searchQuery, sortItems } from "./listing";
import type { Usage } from "./usage";

export interface SpaceInfo {
  id: string;
  root_folder: string;
}

/** The person's own space: its id (every action is on it) and their top folder. */
export function useSpace() {
  return useQuery({
    queryKey: ["drive", "space"],
    queryFn: ({ signal }) => api.get<SpaceInfo>("/api/app/drive/space", undefined, signal),
  });
}

/** Storage: the person's, their team folders', and the limits to tell them about. */
export function useUsage() {
  return useQuery({
    queryKey: ["drive", "usage"],
    queryFn: ({ signal }) => api.get<Usage>("/api/app/drive/usage", undefined, signal),
    staleTime: 15_000,
  });
}

/** A folder as the person sees it: its name, their level on it, the folders above it. */
export interface FolderInfo extends Item {
  breadcrumbs?: Crumb[];
}

export function useFolder(id: string | undefined) {
  return useQuery({
    queryKey: ["drive", "item", id],
    queryFn: ({ signal }) => api.get<FolderInfo>("/api/app/drive/item_info", { item: id }, signal),
    enabled: !!id,
    staleTime: 0,
  });
}

/** How many items one request brings. The server allows 200. */
export const PAGE = 100;

interface Page {
  items: Item[];
  offset: number;
  /** Where the next page begins; none after the last. */
  next?: number;
}

const ACTIONS: Record<string, string> = Object.fromEntries(VIEWS.map((v) => [v.id, v.action]));

/** The request for a page of a source: what to call and with what. */
export function request(src: Source, q: Query, today: string): [string, Record<string, string | number | undefined>] {
  switch (src.kind) {
    case "folder":
      return ["list_folder", { folder: src.folder, sort: q.sort ?? undefined, order: q.sort ? (q.order ?? naturalOrder(q.sort)) : undefined, limit: PAGE }];
    case "search":
      return ["search", { ...searchQuery(src, q, today), limit: PAGE }];
    case "trash":
      return ["list_trash", { limit: PAGE }];
    case "view":
      return [ACTIONS[src.view], {}];
  }
}

export interface Listed {
  items: Item[];
  /** How many there are, where the server says. */
  total: number | null;
  loading: boolean;
  error: unknown;
  refetch: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

/** The items of a source, a page at a time. Views the page holds whole (shared with me, recent,
 *  starred) are sorted and filtered here; the others are sorted and filtered by the server. */
export function useListing(src: Source | null, q: Query): Listed {
  const today = todayIso();
  const own = src?.kind === "view";
  // The server's sort and filters make a different list; a view's are done here and change nothing asked.
  const asked = src ? JSON.stringify([src, own ? null : [q.sort, q.order, q.type, q.since, q.owner], src.kind === "search" ? today : null]) : "none";
  const list = useInfiniteQuery({
    queryKey: ["drive", "list", asked],
    enabled: !!src,
    staleTime: 0,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }): Promise<Page & { total: number | null }> => {
      const [action, query] = request(src!, q, today);
      const r = await api.get<{ items: Item[]; total?: number; folders?: number; has_more?: boolean }>(`/api/app/drive/${action}`, { ...query, offset: pageParam || undefined }, signal);
      // The lists that count their items say how many there are; the others say whether more follow.
      const more: { total: number } | { hasMore: boolean } =
        src!.kind === "folder" || src!.kind === "trash" ? { total: r.total ?? r.items.length } : { hasMore: src!.kind === "search" && !!r.has_more };
      return { items: r.items, offset: pageParam, next: nextOffset(pageParam, r.items.length, more), total: "total" in more ? more.total : null };
    },
    getNextPageParam: (last) => last.next,
  });
  const loaded = useMemo(() => flatten(list.data?.pages ?? []), [list.data]);
  const items = useMemo(() => {
    if (!src || src.kind !== "view") return loaded;
    const kept = filterItems(loaded, q);
    return q.sort ? sortItems(kept, q.sort, q.order ?? naturalOrder(q.sort)) : kept;
  }, [loaded, src, q]);
  const total = list.data?.pages[0]?.total ?? null;
  const { hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = list;
  // The same function while nothing changes: the page watches its end with it.
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return {
    items,
    total,
    loading: !!src && list.isPending,
    error: list.error,
    refetch: () => void refetch(),
    hasMore: !!hasNextPage,
    loadingMore: isFetchingNextPage,
    loadMore,
  };
}

/** Keeps what is on screen current: files and folders changing (Drive administrators hear of every
 *  change; for everyone else the lists fetch again on each visit and when the page comes back to
 *  the front). Many changes at once, an upload of a folder, fetch once. */
export function useFresh() {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void qc.invalidateQueries({ queryKey: ["drive"] }), 400);
  }, [qc]);
  useLiveEntity("DriveFile", refresh);
  useLiveEntity("DriveFolder", refresh);
  useEffect(() => {
    const back = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      clearTimeout(timer.current);
    };
  }, [refresh]);
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  adjustColumnGutter,
  defaultColumnWidths,
  normalizeColumnWidths,
  partitionBelowGroupsByColumn,
  type ConfigColumnCount,
} from "../lib/configColumnLayout";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import {
  groupOrderKey,
  loadConfigColumnCount,
  loadConfigColumnWidths,
  loadGroupColumn,
  normalizeUiGroup,
  readJsonStorage,
  resolveGroupOrder,
  saveConfigColumnCount,
  saveConfigColumnWidths,
} from "../lib/storage";
import type { ProviderConfig } from "../lib/types";

interface UseConfigColumnsArgs {
  providerId: string;
  currentProvider: ProviderConfig | undefined;
  layoutParams: Array<{ ui_group?: string }>;
  groupedParams: Record<string, unknown[]>;
}

/**
 * Column engine for the maintenance bay: 1/2/3 columns, gutter resize, and an
 * optional explicit `groupColumn` map. With no map, groups spread across the
 * chosen columns so 1/2/3 stays useful without a template layout. No layout
 * mode, no drag, no above/below.
 */
export function useConfigColumns({
  providerId,
  currentProvider,
  layoutParams,
  groupedParams,
}: UseConfigColumnsArgs) {
  const [columnCount, setColumnCount] = useState<ConfigColumnCount>(1);
  const [columnWidths, setColumnWidths] = useState<number[]>([1]);
  const [groupColumn, setGroupColumn] = useState<Record<string, number>>({});
  const [draggingGutterIndex, setDraggingGutterIndex] = useState<number | null>(null);
  const gutterDragRef = useRef<{ gutterIndex: number; startX: number; startWidths: number[] } | null>(
    null,
  );
  const dragListenersRef = useRef<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null>(
    null,
  );

  const reloadColumnLayout = useCallback(() => {
    const count = loadConfigColumnCount(providerId, currentProvider?.configColumnCount);
    setColumnCount(count);
    setColumnWidths(loadConfigColumnWidths(providerId, count, currentProvider?.configColumnWidths));
    setGroupColumn(loadGroupColumn(providerId, currentProvider?.groupColumn));
  }, [providerId, currentProvider]);

  useEffect(() => {
    reloadColumnLayout();
  }, [reloadColumnLayout]);

  useEffect(() => {
    const onConfigChanged = () => reloadColumnLayout();
    window.addEventListener(EVENTS.paramConfigChanged, onConfigChanged);
    window.addEventListener(EVENTS.reloadProviders, onConfigChanged);
    return () => {
      window.removeEventListener(EVENTS.paramConfigChanged, onConfigChanged);
      window.removeEventListener(EVENTS.reloadProviders, onConfigChanged);
    };
  }, [reloadColumnLayout]);

  const persistProviderPatch = useCallback(
    async (patch: Partial<ProviderConfig>) => {
      if (!currentProvider) return;
      const updated = { ...currentProvider, ...patch };
      try {
        await invoke("save_provider", { provider: updated });
        dispatchAppEvent(EVENTS.reloadProviders);
      } catch {
        /* ignore — the panel keeps working from local state */
      }
    },
    [currentProvider],
  );

  const saveColumnLayout = useCallback(
    async (count: ConfigColumnCount, widths: number[]) => {
      const normalizedWidths = normalizeColumnWidths(count, widths);
      saveConfigColumnCount(providerId, count);
      saveConfigColumnWidths(providerId, normalizedWidths);
      setColumnCount(count);
      setColumnWidths(normalizedWidths);
      await persistProviderPatch({
        configColumnCount: count,
        configColumnWidths: normalizedWidths,
      });
      dispatchAppEvent(EVENTS.paramConfigChanged);
    },
    [providerId, persistProviderPatch],
  );

  const setBelowColumnCount = useCallback(
    (count: ConfigColumnCount) => {
      const loaded = loadConfigColumnWidths(providerId, count, currentProvider?.configColumnWidths);
      const normalized = normalizeColumnWidths(
        count,
        loaded.length === count ? loaded : defaultColumnWidths(count),
      );
      void saveColumnLayout(count, normalized);
    },
    [providerId, currentProvider, saveColumnLayout],
  );

  const clearDragListeners = useCallback(() => {
    const listeners = dragListenersRef.current;
    if (!listeners) return;
    document.removeEventListener("mousemove", listeners.move);
    document.removeEventListener("mouseup", listeners.up);
    dragListenersRef.current = null;
  }, []);

  useEffect(
    () => () => {
      clearDragListeners();
      gutterDragRef.current = null;
    },
    [clearDragListeners],
  );

  const handleGutterDragStart = useCallback(
    (gutterIndex: number, e: React.MouseEvent) => {
      if (columnCount < 2) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) return;

      clearDragListeners();
      const container = (e.currentTarget as HTMLElement).closest(
        ".config-params-below--multi",
      ) as HTMLElement | null;
      const startWidths = [...columnWidths];
      gutterDragRef.current = { gutterIndex, startX: e.clientX, startWidths };
      setDraggingGutterIndex(gutterIndex);

      const onMove = (ev: MouseEvent) => {
        const ctx = gutterDragRef.current;
        if (!ctx || !container) return;
        const width = container.getBoundingClientRect().width;
        const delta = ev.clientX - ctx.startX;
        setColumnWidths(adjustColumnGutter(ctx.startWidths, ctx.gutterIndex, delta, width));
      };

      const onUp = (ev: MouseEvent) => {
        const ctx = gutterDragRef.current;
        gutterDragRef.current = null;
        setDraggingGutterIndex(null);
        clearDragListeners();
        if (!ctx) return;
        const containerEl = document.querySelector(
          ".config-params-below--multi",
        ) as HTMLElement | null;
        const width = containerEl?.getBoundingClientRect().width ?? 0;
        const delta = ev.clientX - ctx.startX;
        const next = adjustColumnGutter(ctx.startWidths, ctx.gutterIndex, delta, width);
        void saveColumnLayout(columnCount, next);
      };

      dragListenersRef.current = { move: onMove, up: onUp };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [columnCount, columnWidths, clearDragListeners, saveColumnLayout],
  );

  const customGroupOrder = useMemo(() => {
    const stored = readJsonStorage<string[]>(groupOrderKey(providerId));
    if (stored?.length) return stored.map(normalizeUiGroup);
    if (currentProvider?.groupOrder?.length) {
      return currentProvider.groupOrder.map(normalizeUiGroup);
    }
    return null;
  }, [providerId, currentProvider]);

  const orderedGroupKeys = useMemo(
    () => resolveGroupOrder(layoutParams, customGroupOrder),
    [layoutParams, customGroupOrder],
  );

  const belowGroupKeys = useMemo(
    () => orderedGroupKeys.filter((groupId) => (groupedParams[groupId]?.length ?? 0) > 0),
    [orderedGroupKeys, groupedParams],
  );

  const effectiveGroupColumn = useMemo(() => {
    if (Object.keys(groupColumn).length > 0) return groupColumn;
    const next: Record<string, number> = {};
    belowGroupKeys.forEach((key, index) => {
      next[normalizeUiGroup(key)] = index % columnCount;
    });
    return next;
  }, [groupColumn, belowGroupKeys, columnCount]);

  const belowGroupsByColumn = useMemo(
    () => partitionBelowGroupsByColumn(belowGroupKeys, effectiveGroupColumn, columnCount),
    [belowGroupKeys, effectiveGroupColumn, columnCount],
  );

  return {
    orderedGroupKeys,
    belowGroupKeys,
    belowGroupsByColumn,
    columnCount,
    columnWidths,
    groupColumn,
    draggingGutterIndex,
    handleGutterDragStart,
    setBelowColumnCount,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  applyBelowGroupDrop,
  adjustColumnGutter,
  moveGroupToColumn,
  effectiveGroupColumn,
  defaultColumnWidths,
  findGroupDropTarget,
  normalizeColumnWidths,
  ABOVE_COLUMN_COUNT,
  partitionBelowGroupsByColumn,
  partitionAboveGroupsByColumn,
  type ConfigColumnCount,
} from "../lib/configColumnLayout";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import {
  findGroupDropIndex,
  isGroupFullyHidden,
  partitionGroupsByDisplayZone,
  reorderGroupsWithinZone,
  type GroupDisplayZone,
} from "../lib/paramDisplayZone";
import {
  isEmptyGroupDeletable,
  pruneStaleGroupOrder,
  resolveGroupOrderForAdmin,
  stripGroupFromLayout,
} from "../lib/groupLayoutUtils";
import {
  groupOrderKey,
  loadAboveColumnWidths,
  loadConfigColumnCount,
  loadConfigColumnWidths,
  loadGroupColumn,
  loadGroupDisplayZone,
  normalizeUiGroup,
  readJsonStorage,
  resolveGroupOrder,
  saveAboveColumnWidths,
  saveConfigColumnCount,
  saveConfigColumnWidths,
  saveGroupColumn,
  saveGroupDisplayZone,
  writeJsonStorage,
} from "../lib/storage";
import type { ProviderConfig, UserEditedTemplateParam } from "../lib/types";

interface DragContext {
  groupName: string;
  zone: GroupDisplayZone;
  zoneKeys: string[];
  orderedKeys: string[];
  hasMoved: boolean;
  startX: number;
  startY: number;
}

interface UseGroupLayoutControlsArgs {
  providerId: string;
  currentProvider: ProviderConfig | undefined;
  layoutParams: Array<{ ui_group?: string }>;
  groupedParams: Record<string, UserEditedTemplateParam[]>;
  allGroupedParams: Record<string, UserEditedTemplateParam[]>;
  layoutModeActive: boolean;
  isGroupVisible?: (groupId: string) => boolean;
}

export function useGroupLayoutControls({
  providerId,
  currentProvider,
  layoutParams,
  groupedParams,
  allGroupedParams,
  layoutModeActive,
  isGroupVisible,
}: UseGroupLayoutControlsArgs) {
  const [customGroupOrder, setCustomGroupOrder] = useState<string[] | null>(null);
  const [groupDisplayZone, setGroupDisplayZone] = useState<Record<string, GroupDisplayZone>>({});
  const [columnCount, setColumnCount] = useState<ConfigColumnCount>(1);
  const [columnWidths, setColumnWidths] = useState<number[]>([1]);
  const [groupColumn, setGroupColumn] = useState<Record<string, number>>({});
  const [aboveColumnWidths, setAboveColumnWidths] = useState<[number, number]>([0.65, 0.35]);

  const reloadColumnLayout = useCallback(() => {
    const count = loadConfigColumnCount(providerId, currentProvider?.configColumnCount);
    setColumnCount(count);
    setColumnWidths(loadConfigColumnWidths(providerId, count, currentProvider?.configColumnWidths));
    setGroupColumn(loadGroupColumn(providerId, currentProvider?.groupColumn));
    setAboveColumnWidths(loadAboveColumnWidths(providerId, currentProvider?.aboveColumnWidths));
  }, [providerId, currentProvider]);

  useEffect(() => {
    try {
      const stored = readGroupOrder(providerId, currentProvider);
      setCustomGroupOrder(stored);
    } catch {
      setCustomGroupOrder(null);
    }
  }, [providerId, currentProvider]);

  useEffect(() => {
    setGroupDisplayZone(loadGroupDisplayZone(providerId, currentProvider?.groupDisplayZone));
    reloadColumnLayout();
  }, [providerId, currentProvider, reloadColumnLayout]);

  useEffect(() => {
    const onConfigChanged = () => {
      setGroupDisplayZone(loadGroupDisplayZone(providerId, currentProvider?.groupDisplayZone));
      setCustomGroupOrder(readGroupOrder(providerId, currentProvider));
      reloadColumnLayout();
    };
    window.addEventListener(EVENTS.paramConfigChanged, onConfigChanged);
    window.addEventListener(EVENTS.reloadProviders, onConfigChanged);
    return () => {
      window.removeEventListener(EVENTS.paramConfigChanged, onConfigChanged);
      window.removeEventListener(EVENTS.reloadProviders, onConfigChanged);
    };
  }, [providerId, currentProvider, reloadColumnLayout]);

  const persistProviderPatch = useCallback(
    async (patch: Partial<ProviderConfig>) => {
      if (!currentProvider) return;
      const updated = { ...currentProvider, ...patch };
      try {
        await invoke("save_provider", { provider: updated });
        dispatchAppEvent(EVENTS.reloadProviders);
      } catch {
        /* ignore */
      }
    },
    [currentProvider],
  );

  const saveGroupOrder = useCallback(
    async (newOrder: string[]) => {
      const normalized = newOrder.map(normalizeUiGroup);
      writeJsonStorage(groupOrderKey(providerId), normalized);
      setCustomGroupOrder(normalized);
      await persistProviderPatch({ groupOrder: normalized });
      dispatchAppEvent(EVENTS.paramConfigChanged);
    },
    [providerId, persistProviderPatch],
  );

  useEffect(() => {
    if (!customGroupOrder?.length || layoutParams.length === 0) return;
    const pruned = pruneStaleGroupOrder(customGroupOrder, layoutParams);
    if (pruned.length === customGroupOrder.length) return;
    void saveGroupOrder(pruned);
  }, [customGroupOrder, layoutParams, saveGroupOrder]);

  const saveGroupColumnState = useCallback(
    async (next: Record<string, number>) => {
      const normalized: Record<string, number> = {};
      for (const [k, v] of Object.entries(next)) {
        normalized[normalizeUiGroup(k)] = v;
      }
      saveGroupColumn(providerId, normalized);
      setGroupColumn(normalized);
      await persistProviderPatch({ groupColumn: normalized });
      dispatchAppEvent(EVENTS.paramConfigChanged);
    },
    [providerId, persistProviderPatch],
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

  const toggleGroupDisplayZone = useCallback(
    async (groupName: string) => {
      const normalized = normalizeUiGroup(groupName);
      const next = { ...groupDisplayZone };
      if (next[normalized] === "above") delete next[normalized];
      else next[normalized] = "above";
      saveGroupDisplayZone(providerId, next);
      setGroupDisplayZone(next);
      await persistProviderPatch({ groupDisplayZone: next });
      dispatchAppEvent(EVENTS.paramConfigChanged);
    },
    [groupDisplayZone, providerId, persistProviderPatch],
  );

  const toggleGroupHidden = useCallback(
    async (groupId: string) => {
      try {
        await invoke<boolean>("toggle_group_hidden", { providerId, groupId });
        dispatchAppEvent(EVENTS.reloadProviders);
        dispatchAppEvent(EVENTS.paramConfigChanged);
      } catch (err) {
        console.error("[toggle_group_hidden] failed:", err);
      }
    },
    [providerId],
  );

  const deleteEmptyGroup = useCallback(
    async (groupName: string) => {
      if (!isEmptyGroupDeletable(groupName, allGroupedParams)) return;
      const baseOrder = customGroupOrder ?? [];
      const stripped = stripGroupFromLayout(
        groupName,
        baseOrder,
        groupDisplayZone,
        groupColumn,
      );
      void saveGroupOrder(stripped.groupOrder);
      saveGroupDisplayZone(providerId, stripped.groupDisplayZone);
      setGroupDisplayZone(stripped.groupDisplayZone);
      saveGroupColumn(providerId, stripped.groupColumn);
      setGroupColumn(stripped.groupColumn);
      await persistProviderPatch({
        groupOrder: stripped.groupOrder,
        groupDisplayZone: stripped.groupDisplayZone,
        groupColumn: stripped.groupColumn,
      });
      dispatchAppEvent(EVENTS.paramConfigChanged);
    },
    [
      allGroupedParams,
      customGroupOrder,
      groupDisplayZone,
      groupColumn,
      providerId,
      saveGroupOrder,
      persistProviderPatch,
    ],
  );

  const orderedGroupKeys = useMemo(() => {
    const allGroups = new Set([
      ...Object.keys(groupedParams),
      ...Object.keys(allGroupedParams),
    ]);
    const order = layoutModeActive
      ? resolveGroupOrderForAdmin(layoutParams, customGroupOrder)
      : resolveGroupOrder(layoutParams, customGroupOrder);
    return order.filter(
      (g) => allGroups.has(g) || (layoutModeActive && isEmptyGroupDeletable(g, allGroupedParams)),
    );
  }, [layoutParams, customGroupOrder, groupedParams, allGroupedParams, layoutModeActive]);

  const groupIncluded = useCallback(
    (groupId: string) => {
      if (isGroupVisible) return isGroupVisible(groupId);
      if ((groupedParams[groupId]?.length ?? 0) > 0) return true;
      if (layoutModeActive && isEmptyGroupDeletable(groupId, allGroupedParams)) return true;
      return layoutModeActive && isGroupFullyHidden(groupId, allGroupedParams);
    },
    [isGroupVisible, groupedParams, allGroupedParams, layoutModeActive],
  );

  const { aboveKeys: aboveGroupKeys, belowKeys: belowGroupKeys } = useMemo(
    () => partitionGroupsByDisplayZone(orderedGroupKeys, groupDisplayZone, groupIncluded),
    [orderedGroupKeys, groupDisplayZone, groupIncluded],
  );

  const belowGroupsByColumn = useMemo(
    () => partitionBelowGroupsByColumn(belowGroupKeys, groupColumn, columnCount),
    [belowGroupKeys, groupColumn, columnCount],
  );

  const aboveGroupsByColumn = useMemo(
    () => partitionAboveGroupsByColumn(aboveGroupKeys, groupColumn),
    [aboveGroupKeys, groupColumn],
  );

  const isGroupHidden = useCallback(
    (groupId: string) => isGroupFullyHidden(groupId, allGroupedParams),
    [allGroupedParams],
  );

  const dragContextRef = useRef<DragContext | null>(null);
  const dragListenersRef = useRef<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null>(null);
  const gutterDragRef = useRef<{ gutterIndex: number; startX: number; startWidths: number[] } | null>(null);
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);
  const [draggingGutterIndex, setDraggingGutterIndex] = useState<number | null>(null);
  const [draggingAboveGutterIndex, setDraggingAboveGutterIndex] = useState<number | null>(null);

  const clearDragListeners = useCallback(() => {
    const listeners = dragListenersRef.current;
    if (!listeners) return;
    document.removeEventListener("mousemove", listeners.move);
    document.removeEventListener("mouseup", listeners.up);
    dragListenersRef.current = null;
  }, []);

  useEffect(() => () => {
    clearDragListeners();
    dragContextRef.current = null;
    gutterDragRef.current = null;
  }, [clearDragListeners]);

  const finishDrag = useCallback(
    (clientX: number, clientY: number) => {
      const ctx = dragContextRef.current;
      dragContextRef.current = null;
      setDraggingGroup(null);
      clearDragListeners();
      if (!ctx?.hasMoved) return;

      const panel = document.querySelector("[data-config-panel]");

      if (ctx.zone === "above" && ctx.zoneKeys.length > 0) {
        const target = findGroupDropTarget(clientX, clientY, "above", panel ?? document);
        if (!target) return;
        const { newOrder, newGroupColumn } = applyBelowGroupDrop(
          ctx.orderedKeys,
          ctx.zoneKeys,
          groupColumn,
          ABOVE_COLUMN_COUNT,
          ctx.groupName,
          target.columnIdx,
          target.groupIdx,
          "above",
        );
        void saveGroupOrder(newOrder);
        void saveGroupColumnState(newGroupColumn);
        return;
      }

      if (ctx.zone === "below" && columnCount > 1) {
        const target = findGroupDropTarget(clientX, clientY, "below", panel ?? document);
        if (!target) return;
        const { newOrder, newGroupColumn } = applyBelowGroupDrop(
          ctx.orderedKeys,
          ctx.zoneKeys,
          groupColumn,
          columnCount,
          ctx.groupName,
          target.columnIdx,
          target.groupIdx,
        );
        void saveGroupOrder(newOrder);
        void saveGroupColumnState(newGroupColumn);
        return;
      }

      const targetIdx = findGroupDropIndex(clientX, clientY, ctx.zone, panel ?? document);
      const fromIdx = ctx.zoneKeys.indexOf(ctx.groupName);
      if (targetIdx < 0 || fromIdx < 0 || targetIdx === fromIdx) return;

      const newOrder = reorderGroupsWithinZone(ctx.orderedKeys, ctx.zoneKeys, fromIdx, targetIdx);
      void saveGroupOrder(newOrder);
    },
    [
      clearDragListeners,
      columnCount,
      groupColumn,
      saveGroupOrder,
      saveGroupColumnState,
    ],
  );

  const handleGroupDragStart = useCallback(
    (e: React.MouseEvent, zone: GroupDisplayZone, groupName: string) => {
      if (!layoutModeActive) return;
      e.stopPropagation();
      if (e.button !== 0) return;

      clearDragListeners();
      const zoneKeys = zone === "above"
        ? [...aboveGroupKeys]
        : columnCount > 1
          ? [...belowGroupKeys]
          : [...belowGroupKeys];

      dragContextRef.current = {
        groupName,
        zone,
        zoneKeys,
        orderedKeys: [...orderedGroupKeys],
        hasMoved: false,
        startX: e.clientX,
        startY: e.clientY,
      };
      setDraggingGroup(groupName);

      const onMove = (ev: MouseEvent) => {
        const c = dragContextRef.current;
        if (!c) return;
        const dx = Math.abs(ev.clientX - c.startX);
        const dy = Math.abs(ev.clientY - c.startY);
        if (!c.hasMoved && (dx > 3 || dy > 3)) c.hasMoved = true;
      };

      const onUp = (ev: MouseEvent) => {
        finishDrag(ev.clientX, ev.clientY);
      };

      dragListenersRef.current = { move: onMove, up: onUp };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [
      layoutModeActive,
      aboveGroupKeys,
      belowGroupKeys,
      columnCount,
      orderedGroupKeys,
      clearDragListeners,
      finishDrag,
    ],
  );

  const saveAboveColumnLayout = useCallback(
    async (widths: [number, number]) => {
      saveAboveColumnWidths(providerId, widths);
      setAboveColumnWidths(widths);
      await persistProviderPatch({ aboveColumnWidths: widths });
      dispatchAppEvent(EVENTS.paramConfigChanged);
    },
    [providerId, persistProviderPatch],
  );

  const shiftGroupColumn = useCallback(
    (groupId: string, direction: -1 | 1, zone: GroupDisplayZone = "below") => {
      const zoneColumnCount = zone === "above" ? ABOVE_COLUMN_COUNT : columnCount;
      const zoneKeys = zone === "above" ? aboveGroupKeys : belowGroupKeys;
      if (zoneColumnCount < 2) return;
      const current = effectiveGroupColumn(
        groupId,
        zoneKeys,
        groupColumn,
        zoneColumnCount,
        zone,
      );
      const target = current + direction;
      if (target < 0 || target >= zoneColumnCount || target === current) return;
      const { newOrder, newGroupColumn } = moveGroupToColumn(
        orderedGroupKeys,
        zoneKeys,
        groupColumn,
        zoneColumnCount,
        groupId,
        target,
      );
      void saveGroupOrder(newOrder);
      void saveGroupColumnState(newGroupColumn);
    },
    [
      columnCount,
      groupColumn,
      orderedGroupKeys,
      belowGroupKeys,
      aboveGroupKeys,
      saveGroupOrder,
      saveGroupColumnState,
    ],
  );

  const handleGutterDragStart = useCallback(
    (gutterIndex: number, e: React.MouseEvent) => {
      if (columnCount < 2) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) return;

      clearDragListeners();
      const container = (e.currentTarget as HTMLElement).closest(".config-params-below--multi") as HTMLElement | null;
      const startWidths = [...columnWidths];
      gutterDragRef.current = { gutterIndex, startX: e.clientX, startWidths };
      setDraggingGutterIndex(gutterIndex);
      const onMove = (ev: MouseEvent) => {
        const ctx = gutterDragRef.current;
        if (!ctx || !container) return;
        const width = container.getBoundingClientRect().width;
        const delta = ev.clientX - ctx.startX;
        const next = adjustColumnGutter(ctx.startWidths, ctx.gutterIndex, delta, width);
        setColumnWidths(next);
      };

      const onUp = (ev: MouseEvent) => {
        const ctx = gutterDragRef.current;
        gutterDragRef.current = null;
        setDraggingGutterIndex(null);
        clearDragListeners();
        if (!ctx) return;
        const container = document.querySelector(".config-params-below--multi") as HTMLElement | null;
        const width = container?.getBoundingClientRect().width ?? 0;
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

  const handleAboveGutterDragStart = useCallback(
    (gutterIndex: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) return;

      clearDragListeners();
      const container = (e.currentTarget as HTMLElement).closest(
        ".config-params-above--multi",
      ) as HTMLElement | null;
      const startWidths = [...aboveColumnWidths];
      gutterDragRef.current = { gutterIndex, startX: e.clientX, startWidths };
      setDraggingAboveGutterIndex(gutterIndex);

      const onMove = (ev: MouseEvent) => {
        const ctx = gutterDragRef.current;
        if (!ctx || !container) return;
        const width = container.getBoundingClientRect().width;
        const delta = ev.clientX - ctx.startX;
        const next = adjustColumnGutter(ctx.startWidths, ctx.gutterIndex, delta, width);
        setAboveColumnWidths([next[0]!, next[1]!]);
      };

      const onUp = (ev: MouseEvent) => {
        const ctx = gutterDragRef.current;
        gutterDragRef.current = null;
        setDraggingAboveGutterIndex(null);
        clearDragListeners();
        if (!ctx) return;
        const container = document.querySelector(".config-params-above--multi") as HTMLElement | null;
        const width = container?.getBoundingClientRect().width ?? 0;
        const delta = ev.clientX - ctx.startX;
        const next = adjustColumnGutter(ctx.startWidths, ctx.gutterIndex, delta, width);
        void saveAboveColumnLayout([next[0]!, next[1]!]);
      };

      dragListenersRef.current = { move: onMove, up: onUp };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [aboveColumnWidths, clearDragListeners, saveAboveColumnLayout],
  );

  return {
    orderedGroupKeys,
    aboveGroupKeys,
    belowGroupKeys,
    belowGroupsByColumn,
    aboveGroupsByColumn,
    aboveColumnWidths,
    groupDisplayZone,
    columnCount,
    columnWidths,
    groupColumn,
    draggingGroup,
    draggingGutterIndex,
    draggingAboveGutterIndex,
    handleGroupDragStart,
    handleGutterDragStart,
    handleAboveGutterDragStart,
    shiftGroupColumn,
    setBelowColumnCount,
    toggleGroupDisplayZone,
    toggleGroupHidden,
    deleteEmptyGroup,
    isGroupHidden,
  };
}

function readGroupOrder(
  providerId: string,
  currentProvider: ProviderConfig | undefined,
): string[] | null {
  const stored = readJsonStorage<string[]>(groupOrderKey(providerId));
  if (stored) return stored.map((g) => normalizeUiGroup(g));
  if (currentProvider?.groupOrder && currentProvider.groupOrder.length > 0) {
    return currentProvider.groupOrder.map((g) => normalizeUiGroup(g));
  }
  return null;
}
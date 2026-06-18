import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import {
  findGroupDropIndex,
  isGroupFullyHidden,
  partitionGroupsByDisplayZone,
  reorderGroupsWithinZone,
  type GroupDisplayZone,
} from "../lib/paramDisplayZone";
import {
  groupOrderKey,
  loadGroupDisplayZone,
  normalizeUiGroup,
  readJsonStorage,
  resolveGroupOrder,
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
  }, [providerId, currentProvider]);

  useEffect(() => {
    const onConfigChanged = () => {
      setGroupDisplayZone(loadGroupDisplayZone(providerId, currentProvider?.groupDisplayZone));
      setCustomGroupOrder(readGroupOrder(providerId, currentProvider));
    };
    window.addEventListener(EVENTS.paramConfigChanged, onConfigChanged);
    window.addEventListener(EVENTS.reloadProviders, onConfigChanged);
    return () => {
      window.removeEventListener(EVENTS.paramConfigChanged, onConfigChanged);
      window.removeEventListener(EVENTS.reloadProviders, onConfigChanged);
    };
  }, [providerId, currentProvider]);

  const saveGroupOrder = useCallback(
    async (newOrder: string[]) => {
      const normalized = newOrder.map(normalizeUiGroup);
      writeJsonStorage(groupOrderKey(providerId), normalized);
      setCustomGroupOrder(normalized);
      if (currentProvider) {
        const updated = { ...currentProvider, groupOrder: normalized };
        try {
          await invoke("save_provider", { provider: updated });
          dispatchAppEvent(EVENTS.reloadProviders);
        } catch {
          /* ignore */
        }
      }
      dispatchAppEvent(EVENTS.paramConfigChanged);
    },
    [providerId, currentProvider],
  );

  const toggleGroupDisplayZone = useCallback(
    async (groupName: string) => {
      const normalized = normalizeUiGroup(groupName);
      const next = { ...groupDisplayZone };
      if (next[normalized] === "above") delete next[normalized];
      else next[normalized] = "above";
      saveGroupDisplayZone(providerId, next);
      setGroupDisplayZone(next);
      if (currentProvider) {
        const updated = { ...currentProvider, groupDisplayZone: next };
        try {
          await invoke("save_provider", { provider: updated });
          dispatchAppEvent(EVENTS.reloadProviders);
        } catch {
          /* ignore */
        }
      }
      dispatchAppEvent(EVENTS.paramConfigChanged);
    },
    [groupDisplayZone, providerId, currentProvider],
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

  const orderedGroupKeys = useMemo(() => {
    const allGroups = new Set([
      ...Object.keys(groupedParams),
      ...Object.keys(allGroupedParams),
    ]);
    return resolveGroupOrder(layoutParams, customGroupOrder).filter((g) => allGroups.has(g));
  }, [layoutParams, customGroupOrder, groupedParams, allGroupedParams]);

  const groupIncluded = useCallback(
    (groupId: string) => {
      if (isGroupVisible) return isGroupVisible(groupId);
      if ((groupedParams[groupId]?.length ?? 0) > 0) return true;
      return layoutModeActive && isGroupFullyHidden(groupId, allGroupedParams);
    },
    [isGroupVisible, groupedParams, allGroupedParams, layoutModeActive],
  );

  const { aboveKeys: aboveGroupKeys, belowKeys: belowGroupKeys } = useMemo(
    () => partitionGroupsByDisplayZone(orderedGroupKeys, groupDisplayZone, groupIncluded),
    [orderedGroupKeys, groupDisplayZone, groupIncluded],
  );

  const isGroupHidden = useCallback(
    (groupId: string) => isGroupFullyHidden(groupId, allGroupedParams),
    [allGroupedParams],
  );

  const dragContextRef = useRef<DragContext | null>(null);
  const dragListenersRef = useRef<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null>(null);
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);

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
  }, [clearDragListeners]);

  const finishDrag = useCallback(
    (clientX: number, clientY: number) => {
      const ctx = dragContextRef.current;
      dragContextRef.current = null;
      setDraggingGroup(null);
      clearDragListeners();
      if (!ctx?.hasMoved) return;

      const panel = document.querySelector("[data-config-panel]");
      const targetIdx = findGroupDropIndex(
        clientX,
        clientY,
        ctx.zone,
        panel ?? document,
      );
      const fromIdx = ctx.zoneKeys.indexOf(ctx.groupName);
      if (targetIdx < 0 || fromIdx < 0 || targetIdx === fromIdx) return;

      const newOrder = reorderGroupsWithinZone(ctx.orderedKeys, ctx.zoneKeys, fromIdx, targetIdx);
      void saveGroupOrder(newOrder);
    },
    [clearDragListeners, saveGroupOrder],
  );

  const handleGroupDragStart = useCallback(
    (e: React.MouseEvent, zone: GroupDisplayZone, groupName: string) => {
      if (!layoutModeActive) return;
      e.stopPropagation();
      if (e.button !== 0) return;

      clearDragListeners();
      dragContextRef.current = {
        groupName,
        zone,
        zoneKeys: zone === "above" ? [...aboveGroupKeys] : [...belowGroupKeys],
        orderedKeys: [...orderedGroupKeys],
        hasMoved: false,
        startX: e.clientX,
        startY: e.clientY,
      };
      setDraggingGroup(groupName);

      const onMove = (ev: MouseEvent) => {
        const ctx = dragContextRef.current;
        if (!ctx) return;
        const dx = Math.abs(ev.clientX - ctx.startX);
        const dy = Math.abs(ev.clientY - ctx.startY);
        if (!ctx.hasMoved && (dx > 3 || dy > 3)) ctx.hasMoved = true;
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
      orderedGroupKeys,
      clearDragListeners,
      finishDrag,
    ],
  );

  return {
    orderedGroupKeys,
    aboveGroupKeys,
    belowGroupKeys,
    groupDisplayZone,
    draggingGroup,
    handleGroupDragStart,
    toggleGroupDisplayZone,
    toggleGroupHidden,
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
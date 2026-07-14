import { useCallback, useEffect, useRef, useState } from "react";
import {
  LAUNCH_DOCK_RAIL_WIDTH_DEFAULT,
  LAUNCH_DOCK_RAIL_WIDTH_MAX,
  LAUNCH_DOCK_RAIL_WIDTH_MIN,
  LAUNCH_RAIL_TELEMETRY_RATIO_DEFAULT,
} from "../lib/launchDockLayout";
import {
  CATALOG_SPLIT_WIDTH_DEFAULT,
  CATALOG_SPLIT_WIDTH_MAX,
  CATALOG_SPLIT_WIDTH_MIN,
  loadCatalogListCollapsed,
  loadCatalogSplitWidth,
  loadLaunchDockRailWidth,
  loadLaunchRailTelemetryRatio,
  loadModelHubSplitRatio,
  MODEL_HUB_SPLIT_RATIO_DEFAULT,
  MODEL_HUB_SPLIT_RATIO_MAX,
  MODEL_HUB_SPLIT_RATIO_MIN,
  PLAYGROUND_SPLIT_RATIO_DEFAULT,
  PLAYGROUND_SPLIT_RATIO_MAX,
  PLAYGROUND_SPLIT_RATIO_MIN,
  saveCatalogListCollapsed,
  saveCatalogSplitWidth,
  saveLaunchDockRailWidth,
  saveLaunchRailTelemetryRatio,
  saveModelHubSplitRatio,
} from "../lib/storage";

const MAX_WIDTH_RATIO = 0.65;

export interface PanelSplitResizeConfig {
  loadWidth: () => number;
  saveWidth: (width: number) => void;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

function clampWidth(
  width: number,
  containerWidth: number,
  minWidth: number,
  maxWidth: number,
): number {
  const max = Math.min(maxWidth, Math.floor(containerWidth * MAX_WIDTH_RATIO));
  const effectiveMax = Math.max(minWidth, max);
  return Math.round(Math.min(effectiveMax, Math.max(minWidth, width)));
}

export function usePanelSplitResize(config: PanelSplitResizeConfig) {
  const { loadWidth, saveWidth, defaultWidth, minWidth, maxWidth } = config;
  const containerRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(loadWidth());
  const [panelWidth, setPanelWidth] = useState(widthRef.current);
  const [isDragging, setIsDragging] = useState(false);

  const applyWidth = useCallback((raw: number) => {
    const containerW = containerRef.current?.offsetWidth ?? 0;
    const next =
      containerW > 0
        ? clampWidth(raw, containerW, minWidth, maxWidth)
        : raw;
    widthRef.current = next;
    setPanelWidth(next);
    return next;
  }, [minWidth, maxWidth]);

  const startDrag = useCallback(() => {
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const resetWidth = useCallback(() => {
    const next = applyWidth(defaultWidth);
    saveWidth(next);
  }, [applyWidth, defaultWidth, saveWidth]);

  useEffect(() => {
    if (!isDragging) return;

    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      applyWidth(e.clientX - rect.left);
    };

    const onUp = () => {
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      saveWidth(widthRef.current);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging, applyWidth, saveWidth]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      applyWidth(widthRef.current);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [applyWidth]);

  return {
    containerRef,
    panelWidth,
    isDragging,
    startDrag,
    resetWidth,
  };
}

export function useCatalogSplitResize() {
  const [catalogCollapsed, setCatalogCollapsed] = useState(loadCatalogListCollapsed);
  const split = usePanelSplitResize({
    loadWidth: loadCatalogSplitWidth,
    saveWidth: saveCatalogSplitWidth,
    defaultWidth: CATALOG_SPLIT_WIDTH_DEFAULT,
    minWidth: CATALOG_SPLIT_WIDTH_MIN,
    maxWidth: CATALOG_SPLIT_WIDTH_MAX,
  });

  const setCollapsed = useCallback((next: boolean) => {
    setCatalogCollapsed(next);
    saveCatalogListCollapsed(next);
  }, []);

  const toggleCatalogCollapsed = useCallback(() => {
    setCollapsed(!catalogCollapsed);
  }, [catalogCollapsed, setCollapsed]);

  const expandCatalog = useCallback(() => {
    if (catalogCollapsed) setCollapsed(false);
  }, [catalogCollapsed, setCollapsed]);

  const startCatalogDrag = useCallback(() => {
    if (catalogCollapsed) setCollapsed(false);
    split.startDrag();
  }, [catalogCollapsed, setCollapsed, split]);

  return {
    ...split,
    catalogWidth: catalogCollapsed ? 0 : split.panelWidth,
    catalogCollapsed,
    toggleCatalogCollapsed,
    expandCatalog,
    startDrag: startCatalogDrag,
  };
}

/** Right launch rail — drag handle sits on the rail's left edge. */
export function useLaunchDockRailResize(enabled: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(loadLaunchDockRailWidth());
  const [railWidth, setRailWidth] = useState(widthRef.current);
  const [isDragging, setIsDragging] = useState(false);

  const applyWidth = useCallback((raw: number) => {
    const next = Math.min(
      LAUNCH_DOCK_RAIL_WIDTH_MAX,
      Math.max(LAUNCH_DOCK_RAIL_WIDTH_MIN, Math.round(raw)),
    );
    widthRef.current = next;
    setRailWidth(next);
    return next;
  }, []);

  const startDrag = useCallback(() => {
    if (!enabled) return;
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [enabled]);

  const resetWidth = useCallback(() => {
    const next = applyWidth(LAUNCH_DOCK_RAIL_WIDTH_DEFAULT);
    saveLaunchDockRailWidth(next);
  }, [applyWidth]);

  useEffect(() => {
    if (!enabled || !isDragging) return;

    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      applyWidth(rect.right - e.clientX);
    };

    const onUp = () => {
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      saveLaunchDockRailWidth(widthRef.current);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [enabled, isDragging, applyWidth]);

  useEffect(() => {
    if (!enabled) return;
    applyWidth(widthRef.current);
  }, [enabled, applyWidth]);

  return {
    containerRef,
    railWidth,
    isDragging,
    startDrag,
    resetWidth,
  };
}

/** Vertical split between telemetry HUD and launch block inside the right rail. */
export function useLaunchRailInnerResize(enabled: boolean) {
  const railRef = useRef<HTMLDivElement>(null);
  const ratioRef = useRef(loadLaunchRailTelemetryRatio());
  const [telemetryRatio, setTelemetryRatio] = useState(ratioRef.current);
  const [isDragging, setIsDragging] = useState(false);
  const [railHeight, setRailHeight] = useState(0);
  const [chromeStackHeight, setChromeStackHeight] = useState(0);

  const startDrag = useCallback(() => {
    if (!enabled) return;
    setIsDragging(true);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [enabled]);

  const resetRatio = useCallback(() => {
    ratioRef.current = LAUNCH_RAIL_TELEMETRY_RATIO_DEFAULT;
    setTelemetryRatio(LAUNCH_RAIL_TELEMETRY_RATIO_DEFAULT);
    saveLaunchRailTelemetryRatio(LAUNCH_RAIL_TELEMETRY_RATIO_DEFAULT);
  }, []);

  useEffect(() => {
    if (!enabled || !isDragging) return;

    const onMove = (e: MouseEvent) => {
      const rail = railRef.current;
      if (!rail) return;
      const rect = rail.getBoundingClientRect();
      const next = (e.clientY - rect.top) / Math.max(rect.height, 1);
      const clamped = Math.min(0.72, Math.max(0.22, next));
      ratioRef.current = clamped;
      setTelemetryRatio(clamped);
    };

    const onUp = () => {
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      saveLaunchRailTelemetryRatio(ratioRef.current);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [enabled, isDragging]);

  useEffect(() => {
    if (!enabled || !railRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setRailHeight(railRef.current?.offsetHeight ?? 0);
    });
    observer.observe(railRef.current);
    setRailHeight(railRef.current.offsetHeight);
    return () => observer.disconnect();
  }, [enabled]);

  const telemetryHeight = (() => {
    if (railHeight <= 0) return 0;
    const ratioHeight = railHeight * telemetryRatio;
    const chromeMin = chromeStackHeight > 0 ? chromeStackHeight : 0;
    const handleReserve = 7;
    const maxTelemetry = railHeight - handleReserve - 120;
    return Math.round(Math.min(maxTelemetry, Math.max(ratioHeight, chromeMin)));
  })();

  return {
    railRef,
    telemetryHeight,
    telemetryRatio,
    isDragging,
    startDrag,
    resetRatio,
    setChromeStackHeight,
  };
}

function clampModelHubRatio(ratio: number): number {
  return Math.min(
    MODEL_HUB_SPLIT_RATIO_MAX,
    Math.max(MODEL_HUB_SPLIT_RATIO_MIN, ratio),
  );
}

/** Model Hub split — ratio-based (default 60% results / 40% quants). */
export function useModelHubSplitResize() {
  const containerRef = useRef<HTMLDivElement>(null);
  const ratioRef = useRef(loadModelHubSplitRatio());
  const [panelWidth, setPanelWidth] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const applyRatio = useCallback((rawRatio: number, containerW?: number) => {
    const width = containerW ?? containerRef.current?.offsetWidth ?? 0;
    const ratio = clampModelHubRatio(rawRatio);
    ratioRef.current = ratio;
    if (width > 0) {
      const px = Math.round(width * ratio);
      setPanelWidth(px);
      return px;
    }
    return 0;
  }, []);

  const startDrag = useCallback(() => {
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const resetWidth = useCallback(() => {
    applyRatio(MODEL_HUB_SPLIT_RATIO_DEFAULT);
    saveModelHubSplitRatio(MODEL_HUB_SPLIT_RATIO_DEFAULT);
  }, [applyRatio]);

  useEffect(() => {
    if (!isDragging) return;

    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      applyRatio((e.clientX - rect.left) / rect.width);
    };

    const onUp = () => {
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      saveModelHubSplitRatio(ratioRef.current);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging, applyRatio]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const sync = () => applyRatio(ratioRef.current, container.offsetWidth);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    return () => observer.disconnect();
  }, [applyRatio]);

  return {
    containerRef,
    panelWidth,
    isDragging,
    startDrag,
    resetWidth,
  };
}

/** Playground code/preview split — ratio-based (default 45% code / 55% preview). */
export function usePlaygroundSplitResize(initialRatio: number, onRatioChange: (ratio: number) => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ratioRef = useRef(
    Math.min(PLAYGROUND_SPLIT_RATIO_MAX, Math.max(PLAYGROUND_SPLIT_RATIO_MIN, initialRatio)),
  );
  const [panelWidth, setPanelWidth] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    ratioRef.current = Math.min(
      PLAYGROUND_SPLIT_RATIO_MAX,
      Math.max(PLAYGROUND_SPLIT_RATIO_MIN, initialRatio),
    );
    const width = containerRef.current?.offsetWidth ?? 0;
    if (width > 0) setPanelWidth(Math.round(width * ratioRef.current));
  }, [initialRatio]);

  const applyRatio = useCallback((rawRatio: number, containerW?: number) => {
    const width = containerW ?? containerRef.current?.offsetWidth ?? 0;
    const ratio = Math.min(
      PLAYGROUND_SPLIT_RATIO_MAX,
      Math.max(PLAYGROUND_SPLIT_RATIO_MIN, rawRatio),
    );
    ratioRef.current = ratio;
    if (width > 0) {
      const px = Math.round(width * ratio);
      setPanelWidth(px);
      return px;
    }
    return 0;
  }, []);

  const startDrag = useCallback(() => {
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const resetWidth = useCallback(() => {
    applyRatio(PLAYGROUND_SPLIT_RATIO_DEFAULT);
    onRatioChange(PLAYGROUND_SPLIT_RATIO_DEFAULT);
  }, [applyRatio, onRatioChange]);

  useEffect(() => {
    if (!isDragging) return;

    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      applyRatio((e.clientX - rect.left) / rect.width);
    };

    const onUp = () => {
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onRatioChange(ratioRef.current);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging, applyRatio, onRatioChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const sync = () => applyRatio(ratioRef.current, container.offsetWidth);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    return () => observer.disconnect();
  }, [applyRatio]);

  return {
    containerRef,
    panelWidth,
    isDragging,
    startDrag,
    resetWidth,
  };
}
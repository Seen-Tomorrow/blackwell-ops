import { useCallback, useEffect, useRef, useState } from "react";
import {
  CATALOG_SPLIT_WIDTH_DEFAULT,
  CATALOG_SPLIT_WIDTH_MAX,
  CATALOG_SPLIT_WIDTH_MIN,
  loadCatalogSplitWidth,
  saveCatalogSplitWidth,
} from "../lib/storage";

const MAX_WIDTH_RATIO = 0.65;

function clampWidth(width: number, containerWidth: number): number {
  const max = Math.min(
    CATALOG_SPLIT_WIDTH_MAX,
    Math.floor(containerWidth * MAX_WIDTH_RATIO),
  );
  const effectiveMax = Math.max(CATALOG_SPLIT_WIDTH_MIN, max);
  return Math.round(Math.min(effectiveMax, Math.max(CATALOG_SPLIT_WIDTH_MIN, width)));
}

export function useCatalogSplitResize() {
  const containerRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(loadCatalogSplitWidth());
  const [catalogWidth, setCatalogWidth] = useState(widthRef.current);
  const [isDragging, setIsDragging] = useState(false);

  const applyWidth = useCallback((raw: number) => {
    const containerW = containerRef.current?.offsetWidth ?? 0;
    const next = containerW > 0 ? clampWidth(raw, containerW) : raw;
    widthRef.current = next;
    setCatalogWidth(next);
    return next;
  }, []);

  const startDrag = useCallback(() => {
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const resetWidth = useCallback(() => {
    const next = applyWidth(CATALOG_SPLIT_WIDTH_DEFAULT);
    saveCatalogSplitWidth(next);
  }, [applyWidth]);

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
      saveCatalogSplitWidth(widthRef.current);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging, applyWidth]);

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
    catalogWidth,
    isDragging,
    startDrag,
    resetWidth,
  };
}
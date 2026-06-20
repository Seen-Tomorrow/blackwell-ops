import { useState, useEffect, useCallback } from "react";

/** Catalog list/config keyboard nav — off; Ctrl+Enter launch lives in EngineConfigPanel. */
export const MODELS_KEYBOARD_NAV_ENABLED = false;

export type KeyboardZone = "search" | "config" | null;

function isEnterKey(e: KeyboardEvent): boolean {
  return e.key === "Enter" || e.code === "NumpadEnter";
}

interface UseKeyboardNavOptions {
  modelCount: number;
  onSelectModel: (index: number) => void;
  onLaunch?: (highlightIndex: number) => void;
}

// Arrow/Enter navigation for model list and config zone.
export function useKeyboardNav({ modelCount, onSelectModel, onLaunch }: UseKeyboardNavOptions) {
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [zone, setZone] = useState<KeyboardZone>("search");

  useEffect(() => {
    if (!MODELS_KEYBOARD_NAV_ENABLED) return;
    if (highlightIndex >= modelCount) {
      setHighlightIndex(Math.max(0, modelCount - 1));
    }
  }, [modelCount, highlightIndex]);

  const handleArrowKeys = useCallback((e: KeyboardEvent) => {
    if (zone === "config") return; // Config zone handles its own arrows
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex(prev => Math.min(prev + 1, modelCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex(prev => Math.max(prev - 1, 0));
    }
  }, [modelCount, zone]);

  useEffect(() => {
    if (!MODELS_KEYBOARD_NAV_ENABLED) return;
    window.addEventListener("keydown", handleArrowKeys);
    return () => window.removeEventListener("keydown", handleArrowKeys);
  }, [handleArrowKeys]);

  const handleEnter = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey && isEnterKey(e) && onLaunch) {
      e.preventDefault();
      e.stopPropagation();
      onLaunch(highlightIndex);
      return;
    }
    if (isEnterKey(e) && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLInputElement) activeEl.blur();
      onSelectModel(highlightIndex);
      setZone("config");
    }
  }, [highlightIndex, onLaunch, onSelectModel]);

  useEffect(() => {
    if (!MODELS_KEYBOARD_NAV_ENABLED) return;
    window.addEventListener("keydown", handleEnter, true);
    return () => window.removeEventListener("keydown", handleEnter, true);
  }, [handleEnter]);

  useEffect(() => {
    if (!MODELS_KEYBOARD_NAV_ENABLED) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/") {
        e.preventDefault();
        setZone("search");
        const input = document.querySelector('input[placeholder*="SEARCH"]') as HTMLInputElement;
        input?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!MODELS_KEYBOARD_NAV_ENABLED) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && zone === "config") {
        setZone("search");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [zone]);

  useEffect(() => {
    if (!MODELS_KEYBOARD_NAV_ENABLED) return;
    const els = document.querySelectorAll("#model-table-container [data-model-path]");
    els[highlightIndex]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlightIndex]);

  useEffect(() => {
    if (!MODELS_KEYBOARD_NAV_ENABLED) return;
    if (zone !== "config") return;

    const handler = (e: KeyboardEvent) => {
      // Get all interactive elements in config panel
      const configPanel = document.querySelector('[data-config-panel]');
      if (!configPanel) return;

      const chips = Array.from(configPanel.querySelectorAll('.value-chip, .value-chip-active')) as HTMLButtonElement[];
      const currentFocus = document.activeElement as HTMLButtonElement;
      const currentIndex = chips.indexOf(currentFocus);

      if (e.key === "ArrowDown") {
        e.preventDefault();
        // Find next row's chip at same column, or first chip of next row
        const focusedChip = chips[currentIndex];
        if (!focusedChip) { chips[0]?.focus(); return; }
        const currentRow = focusedChip.closest('[data-param-row]');
        const rows = Array.from(configPanel.querySelectorAll('[data-param-row]'));
        const currentRowIndex = rows.indexOf(currentRow);
        if (currentRowIndex >= 0 && currentRowIndex < rows.length - 1) {
          const nextRowChips = Array.from(rows[currentRowIndex + 1].querySelectorAll('.value-chip, .value-chip-active')) as HTMLButtonElement[];
          nextRowChips[0]?.focus();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const focusedChip = chips[currentIndex];
        if (!focusedChip) return;
        const currentRow = focusedChip.closest('[data-param-row]');
        const rows = Array.from(configPanel.querySelectorAll('[data-param-row]'));
        const currentRowIndex = rows.indexOf(currentRow);
        if (currentRowIndex > 0) {
          const prevRowChips = Array.from(rows[currentRowIndex - 1].querySelectorAll('.value-chip, .value-chip-active')) as HTMLButtonElement[];
          prevRowChips[0]?.focus();
        }
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        if (currentIndex < 0) return;
        const direction = e.key === "ArrowRight" ? 1 : -1;
        const nextIndex = currentIndex + direction;
        if (nextIndex >= 0 && nextIndex < chips.length) {
          chips[nextIndex].focus();
        }
      } else if (e.key === "Enter") {
        // If a chip is focused, click it
        if (currentFocus && (currentFocus.classList.contains('value-chip') || currentFocus.classList.contains('value-chip-active'))) {
          e.preventDefault();
          currentFocus.click();
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [zone]);

  useEffect(() => {
    if (!MODELS_KEYBOARD_NAV_ENABLED) return;
    if (zone !== "config") return;
    setTimeout(() => {
      const firstChip = document.querySelector('[data-config-panel] .value-chip, [data-config-panel] .value-chip-active') as HTMLButtonElement | null;
      firstChip?.focus();
    }, 50);
  }, [zone]);

  return { highlightIndex, zone };
}

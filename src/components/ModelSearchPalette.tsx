import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelEntry } from "../lib/types";
import ModelCard from "./ModelCard";

const PALETTE_LIMIT = 5;

interface ModelSearchPaletteProps {
  open: boolean;
  models: ModelEntry[];
  search: string;
  onSearchChange: (q: string) => void;
  selectedPath?: string | null;
  onSelect: (model: ModelEntry) => void;
  onClose: () => void;
  /** Expand full left catalog list and close palette. */
  onOpenFullCatalog?: () => void;
  scanningPath: string | null;
}

/**
 * Floating model picker — does not expand the full catalog split.
 * `/` opens; arrows move; Enter commits; Esc closes; Ctrl+Shift+F → full catalog.
 */
export default function ModelSearchPalette({
  open,
  models,
  search,
  onSearchChange,
  selectedPath,
  onSelect,
  onClose,
  onOpenFullCatalog,
  scanningPath,
}: ModelSearchPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [highlight, setHighlight] = useState(0);

  const hits = useMemo(() => models.slice(0, PALETTE_LIMIT), [models]);

  useEffect(() => {
    if (!open) return;
    setHighlight(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [search]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if ((e.key === "f" || e.key === "F") && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        onOpenFullCatalog?.();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, Math.max(0, hits.length - 1)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        const m = hits[highlight];
        if (m) {
          e.preventDefault();
          e.stopPropagation();
          onSelect(m);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, hits, highlight, onClose, onSelect, onOpenFullCatalog]);

  if (!open) return null;

  return (
    <div
      className="model-search-palette-root fixed inset-0 z-[80] flex items-start justify-center pt-[10vh] px-4"
      role="dialog"
      aria-label="Search models"
    >
      <button
        type="button"
        className="model-search-palette-backdrop absolute inset-0"
        aria-label="Close model search"
        onClick={onClose}
      />
      {/* Dedicated palette chrome — do NOT use catalog-list-scroll (that forces RTL for the left rail). */}
      <div className="model-search-palette relative z-[1] w-full max-w-[480px] rounded-sm overflow-hidden flex flex-col">
        <div className="model-search-palette__header px-3 py-2.5 flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value.replace(/\//g, ""))}
            onKeyDown={(e) => {
              // `/` focuses/opens search — never insert into the query
              if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
              }
            }}
            placeholder="▶  SEARCH MODELS…"
            className="model-search-palette-input theme-input flex-1 min-w-0 font-mono pl-3 py-2 rounded-sm"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="model-search-palette-legend font-mono config-muted shrink-0 tracking-wider">
            ↑↓ · ↵ · Esc
          </span>
        </div>
        <div className="model-search-palette__list p-2.5 space-y-2 max-h-[min(54vh,30rem)] overflow-y-auto overflow-x-hidden">
          {hits.length === 0 ? (
            <p className="text-sm font-mono config-muted text-center py-8 opacity-70">
              {search.trim() ? "NO MATCHING MODELS" : "NO MODELS IN CATALOG"}
            </p>
          ) : (
            hits.map((model, i) => {
              const isFocus = i === highlight;
              const isEngineCurrent = !!selectedPath && selectedPath === model.path;
              return (
                <div
                  key={model.path}
                  className={
                    isFocus
                      ? "ring-2 ring-amber-400/80 rounded-sm"
                      : "rounded-sm"
                  }
                  data-palette-index={i}
                >
                  {/* Keyboard focus only drives ModelCard selection chrome — not last engine model */}
                  <ModelCard
                    model={model}
                    isSelected={isFocus}
                    onSelect={(m) => onSelect(m)}
                    scanningPath={scanningPath}
                  />
                  {isEngineCurrent && !isFocus && (
                    <p className="px-1.5 pb-1 text-[8px] font-mono text-amber-400/80 -mt-0.5">
                      CURRENT ENGINE
                    </p>
                  )}
                  {isEngineCurrent && isFocus && (
                    <p className="px-1.5 pb-1 text-[8px] font-mono text-amber-300/90 -mt-0.5">
                      CURRENT · ↑↓ to move · ↵ select
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>
        <div className="model-search-palette__footer px-3 py-2 flex flex-wrap items-center gap-2 justify-between">
          <p className="text-[10px] font-mono config-muted">
            {models.length > PALETTE_LIMIT
              ? `Showing ${hits.length} of ${models.length}`
              : `${hits.length} model${hits.length === 1 ? "" : "s"}`}
          </p>
          {onOpenFullCatalog && (
            <button
              type="button"
              onClick={onOpenFullCatalog}
              className="value-chip text-[10px] font-mono px-2 py-1 rounded-sm shrink-0"
              title="Open full model catalog (Ctrl+Shift+F)"
            >
              FULL CATALOG ↗
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

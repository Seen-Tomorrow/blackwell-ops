// Live llama-server --help catalog search modal.
// Fetches fresh --help output on open, allows searching and adding params.

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RawCatalogEntry } from "../lib/catalog";
import {
  isCatalogEntryAlreadyActive,
  searchCatalog,
  type CatalogIdentityParam,
} from "../lib/catalog";
import {
  COCKPIT_OWNED_PARAM_KEYS,
  SYSTEM_CATALOG_PARAM_KEYS,
} from "../lib/systemParams";

interface ParamCatalogSearchProps {
  providerId: string;
  existingKeys: string[];
  /** Full identity for alias/flag/reorder match (preferred over existingKeys alone). */
  existingParams?: CatalogIdentityParam[];
  /**
   * Keys that must never be added (SYSTEM chrome, cockpit-owned, etc.).
   * Shown as SYSTEM / blocked rather than ADD.
   */
  blockedKeys?: string[];
  /** When true (editor unlocked), show unfiltered --help catalog. */
  editorUnlocked?: boolean;
  onAdd: (entry: RawCatalogEntry) => void;
  onClose: () => void;
}

function defaultBlockedKeys(): Set<string> {
  return new Set([
    ...SYSTEM_CATALOG_PARAM_KEYS,
    ...COCKPIT_OWNED_PARAM_KEYS,
    "device",
  ]);
}

export default function ParamCatalogSearch({
  providerId,
  existingKeys,
  existingParams,
  blockedKeys,
  editorUnlocked = false,
  onAdd,
  onClose,
}: ParamCatalogSearchProps) {
  const [entries, setEntries] = useState<RawCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const identityParams = useMemo<CatalogIdentityParam[]>(() => {
    if (existingParams && existingParams.length > 0) return existingParams;
    return existingKeys.map((key) => ({ key }));
  }, [existingParams, existingKeys]);

  const blocked = useMemo(() => {
    const s = defaultBlockedKeys();
    for (const k of blockedKeys ?? []) s.add(k);
    // Existing SYSTEM-group / system-catalog params are also banned from re-add.
    for (const p of identityParams) {
      if (SYSTEM_CATALOG_PARAM_KEYS.has(p.key) || COCKPIT_OWNED_PARAM_KEYS.has(p.key)) {
        s.add(p.key);
      }
    }
    return s;
  }, [blockedKeys, identityParams]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    invoke<RawCatalogEntry[]>("get_llama_catalog", {
      providerId,
      includeAll: editorUnlocked,
    })
      .then((data) => {
        setEntries(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(typeof err === "string" ? err : String(err));
        setLoading(false);
      });
  }, [providerId, editorUnlocked]);

  useEffect(() => {
    if (!loading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [loading]);

  const filtered = useMemo(() => searchCatalog(entries, query), [entries, query]);

  const entryStatus = useCallback(
    (entry: RawCatalogEntry): "active" | "system" | "free" => {
      if (blocked.has(entry.key) || blocked.has(entry.key.toLowerCase())) return "system";
      // Block alias hits against system/cockpit keys
      if (isCatalogEntryAlreadyActive(entry, [...blocked].map((key) => ({ key })))) {
        // only if that match is against blocked, not all existing — check blocked identity
        for (const k of blocked) {
          if (isCatalogEntryAlreadyActive(entry, [{ key: k }])) return "system";
        }
      }
      if (isCatalogEntryAlreadyActive(entry, identityParams)) return "active";
      return "free";
    },
    [blocked, identityParams],
  );

  const handleAdd = useCallback(
    (entry: RawCatalogEntry) => {
      if (entryStatus(entry) !== "free") return;
      onAdd(entry);
    },
    [onAdd, entryStatus],
  );

  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-start justify-center pt-14"
      onClick={onClose}
    >
      <div
        className="param-catalog-modal config-form-panel rounded-sm w-full max-w-3xl mx-4 max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 config-section-bar flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-[11px] font-mono theme-accent-text tracking-widest">PARAMETER CATALOG</h2>
            <span className="text-[9px] font-mono config-muted">
              {loading ? "LOADING..." : `${entries.length} params`}
            </span>
            {!loading && (
              <span className={`text-[8px] font-mono px-1.5 py-0.5 rounded-sm tracking-wide ${
                editorUnlocked
                  ? "border border-amber-400/50 text-amber-300 bg-amber-400/10"
                  : "border border-stealth-border/40 config-muted"
              }`}>
                {editorUnlocked
                  ? "UNFILTERED list — be reasonable with what you add!"
                  : "FILTERED"}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="config-muted hover:theme-accent-text transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 config-section-bar flex-shrink-0">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by flag, label, description..."
            className="config-input w-full text-[11px] font-mono px-3 py-2 rounded-sm"
          />
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto eink-scrollbar p-3 min-h-0 space-y-1.5">
          {loading && (
            <div className="flex items-center justify-center py-16 config-muted text-[10px] font-mono animate-pulse tracking-wider">
              RUNNING {providerId.toUpperCase()} --help...
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center py-12 text-red-400 text-[10px] font-mono">
              <div className="text-center space-y-1">
                <div className="font-semibold tracking-wider">CATALOG PARSE FAILED</div>
                <div className="config-muted">{error}</div>
              </div>
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div className="flex items-center justify-center py-16 config-muted text-[10px] font-mono tracking-wider">
              {query ? "NO MATCHES" : "NO PARAMETERS AVAILABLE"}
            </div>
          )}

          {!loading && !error && filtered.map((entry, idx) => {
            const status = entryStatus(entry);
            const rowKey = entry.key ? `${entry.key}-${entry.flag}-${idx}` : `catalog-row-${idx}`;
            return (
              <div
                key={rowKey}
                className={`config-provider-card rounded-sm transition-all ${
                  status !== "free" ? "opacity-50" : "hover:border-[color:var(--theme-chip-hover-border)]"
                }`}
              >
                <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
                  <span className="text-[12px] font-mono font-semibold tracking-tight">
                    {entry.label}
                  </span>
                  <div className="flex-1" />
                  {status === "active" ? (
                    <span className="value-chip-active text-[8px] font-mono px-2 py-1 rounded-sm tracking-wider">
                      ACTIVE
                    </span>
                  ) : status === "system" ? (
                    <span
                      className="text-[8px] font-mono px-2 py-1 rounded-sm tracking-wider border border-electric-blue/35 text-electric-blue/80"
                      title="SYSTEM / cockpit chrome — not addable"
                    >
                      SYSTEM
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleAdd(entry)}
                      className="value-chip-active text-[9px] font-mono px-3 py-1 rounded-sm tracking-wider"
                    >
                      ADD
                    </button>
                  )}
                </div>

                <div className="px-3 pb-2.5 flex items-baseline gap-2 min-h-[1.5em]">
                  <span className="text-[10px] font-mono theme-accent-text opacity-80 shrink-0">
                    {entry.flag}
                    {entry.short && (
                      <span className="config-muted ml-1">{entry.short}</span>
                    )}
                  </span>

                  {entry.default_value !== undefined && entry.default_value !== null && (
                    <>
                      <span className="text-[8px] config-muted opacity-40">·</span>
                      <span className="text-[9px] font-mono config-muted shrink-0">
                        default: {String(entry.default_value)}
                      </span>
                    </>
                  )}

                  <span className="flex-1 min-w-0 text-[10px] config-muted leading-relaxed break-words">
                    {entry.description}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 config-section-bar flex items-center justify-between flex-shrink-0">
          <span className="text-[9px] font-mono config-muted">
            {filtered.length} of {entries.length} shown
          </span>
          <span className="text-[9px] font-mono config-muted tracking-wider">
            ESC to close
          </span>
        </div>
      </div>
    </div>
  );
}

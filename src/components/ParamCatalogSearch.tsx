// Live llama-server --help catalog search modal.
// Fetches fresh --help output on open, allows searching and adding params.

import React, { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RawCatalogEntry } from "../lib/catalog";
import { searchCatalog } from "../lib/catalog";

interface ParamCatalogSearchProps {
  providerId: string;
  existingKeys: string[];
  /** When true (editor unlocked), show unfiltered --help catalog. */
  editorUnlocked?: boolean;
  onAdd: (entry: RawCatalogEntry) => void;
  onClose: () => void;
}

export default function ParamCatalogSearch({
  providerId,
  existingKeys,
  editorUnlocked = false,
  onAdd,
  onClose,
}: ParamCatalogSearchProps) {
  const [entries, setEntries] = useState<RawCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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

  const filtered = React.useMemo(() => searchCatalog(entries, query), [entries, query]);

  const handleAdd = useCallback(
    (entry: RawCatalogEntry) => onAdd(entry),
    [onAdd],
  );

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center pt-14"
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
            const existing = existingKeys.includes(entry.key);
            const rowKey = entry.key ? `${entry.key}-${entry.flag}-${idx}` : `catalog-row-${idx}`;
            return (
              <div
                key={rowKey}
                className={`config-provider-card rounded-sm transition-all ${
                  existing ? "opacity-50" : "hover:border-[color:var(--theme-chip-hover-border)]"
                }`}
              >
                <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
                  <span className="text-[12px] font-mono font-semibold tracking-tight">
                    {entry.label}
                  </span>
                  <div className="flex-1" />
                  {existing ? (
                    <span className="value-chip-active text-[8px] font-mono px-2 py-1 rounded-sm tracking-wider">
                      ACTIVE
                    </span>
                  ) : (
                    <button
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
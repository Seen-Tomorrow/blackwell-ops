// Live llama-server --help catalog search modal.
// Fetches fresh --help output on open, allows searching and adding params.

import React, { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RawCatalogEntry } from "../lib/catalog";
import { searchCatalog } from "../lib/catalog";

interface ParamCatalogSearchProps {
  providerId: string;
  existingKeys: string[];
  onAdd: (entry: RawCatalogEntry) => void;
  onClose: () => void;
}

export default function ParamCatalogSearch({
  providerId,
  existingKeys,
  onAdd,
  onClose,
}: ParamCatalogSearchProps) {
  const [entries, setEntries] = useState<RawCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke<RawCatalogEntry[]>("get_llama_catalog", { providerId })
      .then((data) => {
        setEntries(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(typeof err === "string" ? err : String(err));
        setLoading(false);
      });
  }, [providerId]);

  // Focus input on mount
  useEffect(() => {
    if (!loading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [loading]);

  const filtered = React.useMemo(() => searchCatalog(entries, query), [entries, query]);

  const handleAdd = useCallback(
    (entry: RawCatalogEntry) => {
      onAdd(entry);
    },
    [onAdd],
  );

  const isExisting = (key: string) => existingKeys.includes(key);

  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-start justify-center pt-12"
      onClick={onClose}
    >
      <div
        className="bg-neutral-900 border border-stealth-border rounded-lg w-full max-w-2xl mx-4 max-h-[75vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stealth-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-mono text-nv-green tracking-wider">PARAMETER CATALOG</h2>
            <span className="text-[9px] font-mono text-stealth-muted">
              {loading ? "LOADING..." : `${entries.length} params parsed`}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-stealth-muted hover:text-white transition-colors leading-none"
          >
            ✕
          </button>
        </div>

        {/* Search input */}
        <div className="px-4 py-3 border-b border-stealth-border flex-shrink-0">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by flag, key, label, description..."
            className="w-full bg-black border border-stealth-border/50 text-[11px] font-mono text-white px-3 py-2 focus:outline-none focus:border-nv-green/40 rounded-sm placeholder:text-stealth-muted/50"
          />
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-2 min-h-0">
          {loading && (
            <div className="flex items-center justify-center py-12 text-stealth-muted text-[10px] font-mono animate-pulse">
              RUNNING {providerId.toUpperCase()} --help...
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center py-12 text-red-400 text-[10px] font-mono">
              <div className="text-center">
                <div className="text-red-400 mb-2">⚠ CATALOG PARSE FAILED</div>
                <div className="text-stealth-muted">{error}</div>
              </div>
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div className="flex items-center justify-center py-12 text-stealth-muted text-[10px] font-mono">
              {query ? "NO MATCHES" : "NO PARAMETERS AVAILABLE"}
            </div>
          )}

          {!loading &&
            !error &&
            filtered.map((entry) => {
              const existing = isExisting(entry.key);
              return (
                <div
                  key={entry.key}
                  className={`flex items-start gap-3 px-3 py-2 rounded-sm border transition-colors ${
                    existing
                      ? "border-stealth-border/20 bg-stealth-surface/20 opacity-40"
                      : "border-stealth-border/40 hover:border-stealth-muted/60 hover:bg-stealth-surface/30"
                  }`}
                >
                  {/* Action */}
                  {existing ? (
                    <span className="self-center flex-shrink-0 text-[7px] font-mono text-nv-green/60 bg-nv-green/10 px-2 py-0.5 rounded-sm border border-nv-green/30">
                      ACTIVE
                    </span>
                  ) : (
                    <button
                      onClick={() => handleAdd(entry)}
                      className="self-center flex-shrink-0 px-2 py-0.5 text-[8px] font-mono border border-yellow-400/40 text-yellow-400 hover:bg-yellow-400/15 transition-colors rounded-sm"
                    >
                      ADD
                    </button>
                  )}

                  {/* Key + label */}
                  <div className="w-32 flex-shrink-0 flex flex-col">
                    <span className="text-[10px] font-mono text-nv-green/80">{entry.label}</span>
                    <span className="text-[8px] font-mono text-stealth-muted">{entry.key}</span>
                  </div>

                  {/* Flag */}
                  <div className="w-36 flex-shrink-0 flex flex-col">
                    <span className="text-[10px] font-mono text-white">{entry.flag}</span>
                    {entry.short && (
                      <span className="text-[8px] font-mono text-stealth-muted">{entry.short}</span>
                    )}
                  </div>

                  {/* Default value */}
                  {entry.default_value !== undefined && entry.default_value !== null && (
                    <span className="flex-shrink-0 text-[8px] font-mono text-stealth-muted">
                      default: {String(entry.default_value)}
                    </span>
                  )}

                  {/* Description */}
                  <span className="flex-1 min-w-0 text-[8px] font-mono text-stealth-muted/70 whitespace-normal leading-tight break-all">
                    {entry.description}
                  </span>

                </div>
              );
            })}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-stealth-border flex items-center justify-between flex-shrink-0">
          <span className="text-[8px] font-mono text-stealth-muted">
            {filtered.length} of {entries.length} shown
          </span>
          <span className="text-[8px] font-mono text-stealth-muted">
            ESC to close
          </span>
        </div>
      </div>
    </div>
  );
}

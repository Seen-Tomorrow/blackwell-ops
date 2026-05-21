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
      className="fixed inset-0 bg-black/80 z-50 flex items-start justify-center pt-14"
      onClick={onClose}
    >
      <div
        className="bg-[#1c1c24] border border-white/10 rounded-xl w-full max-w-3xl mx-4 max-h-[80vh] flex flex-col shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-[11px] font-mono text-nv-green tracking-widest font-semibold">PARAMETER CATALOG</h2>
            <span className="text-[9px] font-mono text-white/30">
              {loading ? "LOADING..." : `${entries.length} params`}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-white/30 hover:text-white transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-white/10 flex-shrink-0">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by flag, label, description..."
            className="w-full bg-black/40 border border-white/10 text-[11px] font-mono text-white px-3.5 py-2.5 focus:outline-none focus:border-nv-green/40 rounded-lg placeholder:text-white/20"
          />
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-3 min-h-0 space-y-1.5">
          {loading && (
            <div className="flex items-center justify-center py-16 text-white/30 text-[10px] font-mono animate-pulse tracking-wider">
              RUNNING {providerId.toUpperCase()} --help...
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center py-12 text-red-400/80 text-[10px] font-mono">
              <div className="text-center space-y-1">
                <div className="font-semibold tracking-wider">CATALOG PARSE FAILED</div>
                <div className="text-white/30">{error}</div>
              </div>
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div className="flex items-center justify-center py-16 text-white/25 text-[10px] font-mono tracking-wider">
              {query ? "NO MATCHES" : "NO PARAMETERS AVAILABLE"}
            </div>
          )}

          {!loading && !error && filtered.map((entry) => {
            const existing = existingKeys.includes(entry.key);
            return (
              <div
                key={entry.key}
                className={`group rounded-lg border transition-all ${
                  existing
                    ? "border-white/5 bg-white/[0.02] opacity-40"
                    : "border-white/5 hover:border-white/15 hover:bg-white/[0.03]"
                }`}
              >
                {/* Top row: label + action */}
                <div className="flex items-center gap-2 px-4 pt-3 pb-1">
                  <span className="text-[12px] font-semibold text-white/90 tracking-tight">
                    {entry.label}
                  </span>

                  <div className="flex-1" />

                  {existing ? (
                    <span className="text-[8px] font-mono text-emerald-400/70 bg-emerald-400/5 px-2 py-1 rounded-md border border-emerald-400/20 tracking-wider">
                      ACTIVE
                    </span>
                  ) : (
                    <button
                      onClick={() => handleAdd(entry)}
                      className="px-3 py-1 text-[9px] font-mono bg-yellow-400/10 border border-yellow-400/30 text-yellow-300 hover:bg-yellow-400/20 transition-colors rounded-md tracking-wider"
                    >
                      ADD
                    </button>
                  )}
                </div>

                {/* Bottom row: flags + default + description */}
                <div className="px-4 pb-3 flex items-baseline gap-2 min-h-[1.5em]">
                  <span className="text-[10px] font-mono text-white/60 shrink-0">
                    {entry.flag}
                    {entry.short && (
                      <span className="text-white/25 ml-1">{entry.short}</span>
                    )}
                  </span>

                  {entry.default_value !== undefined && entry.default_value !== null && (
                    <>
                      <span className="text-[8px] text-white/10">·</span>
                      <span className="text-[9px] font-mono text-white/25 shrink-0">
                        default: {String(entry.default_value)}
                      </span>
                    </>
                  )}

                  {/* Description flows into remaining space */}
                  <span className="flex-1 min-w-0 text-[10px] text-white/30 leading-relaxed break-words">
                    {entry.description}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-2.5 border-t border-white/10 flex items-center justify-between flex-shrink-0">
          <span className="text-[9px] font-mono text-white/20">
            {filtered.length} of {entries.length} shown
          </span>
          <span className="text-[9px] font-mono text-white/20 tracking-wider">
            ESC to close
          </span>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { IntelItem } from "../lib/types";

const GENESIS_KEYS = [
  "--ctx-size",
  "--batch-size",
  "--ubatch-size",
  "--parallel",
  "--n-gpu-layers",
  "--split-mode",
  "--mmproj",
  "--reasoning",
  "--reasoning-budget",
  "--reasoning-format",
  "--jinja",
  "--cont-batching",
  "--metrics",
  "--flash-attn",
  "-ctk",
  "-ctv",
  "-ot",
  "--no-mmap",
  "mmap",
];

function highlightGenesisKeys(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const regex = new RegExp(
    `(${GENESIS_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi"
  );
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={match.index} className="text-telemetry-amber font-bold">
        {match[0]}
      </span>
    );
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " " +
      d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return ts.slice(0, 10);
  }
}

function sourceBadge(source: string): React.ReactNode {
  const isPr = source === "pr";
  return (
    <span
      className={`text-[7px] font-mono px-1.5 py-0 rounded-sm flex-shrink-0 ${
        isPr
          ? "text-telemetry-cyan bg-telemetry-cyan/10"
          : "text-nv-green bg-nv-green/10"
      }`}
    >
      {isPr ? "PR" : "DISC"}
    </span>
  );
}

export default function IntelWidget({ compact = false, limit }: { compact?: boolean; limit?: number }) {
  const [items, setItems] = useState<IntelItem[]>([]);
  const [status, setStatus] = useState<"loading" | "online" | "offline">("loading");

  useEffect(() => {
    let cancelled = false;

    invoke<IntelItem[]>("fetch_github_intel")
      .then((data) => {
        if (!cancelled) {
          setItems(data);
          setStatus("online");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("offline");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const displayItems = limit ? items.slice(0, limit) : (compact ? items.slice(0, 2) : items);

  return (
    <div className={`bg-stealth-panel border border-nv-green/40 rounded-sm overflow-hidden flex flex-col ${compact ? "max-h-[180px]" : "h-full"}`}>
      {/* Header */}
      {!compact && (
        <div className="px-4 py-2.5 border-b border-nv-green/30 flex items-center justify-between bg-nv-green/5">
          <h3 className="text-xs font-mono text-nv-green tracking-wider flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-nv-green animate-pulse-slow" />
            BACKEND INTEL
          </h3>
          {status === "offline" && (
            <span className="text-[9px] font-mono text-stealth-muted">OFFLINE</span>
          )}
          {status === "loading" && (
            <span className="text-[9px] font-mono text-stealth-muted animate-pulse">FETCHING...</span>
          )}
          {status === "online" && items.length > 0 && (
            <span className="text-[9px] font-mono text-nv-green/60">{items.length} ITEMS</span>
          )}
        </div>
      )}

      {/* Content */}
      <div className={`${compact ? "max-h-[140px]" : "h-full"} overflow-y-auto`}>
        {status === "offline" ? (
          <p className="text-[10px] font-mono text-stealth-muted/50 italic px-4 py-6 text-center">
            NO INTERNET — INTEL UNAVAILABLE
          </p>
        ) : items.length === 0 && status === "online" ? (
          <p className="text-[10px] font-mono text-stealth-muted/50 italic px-4 py-6 text-center">
            NO RECENT UPDATES FROM GITHUB
          </p>
        ) : (
          displayItems.map((item) => (
            <a
              key={item.id}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`block border-b border-stealth-border hover:bg-white/[0.02] transition-colors cursor-pointer group ${compact ? "px-3 py-2" : "px-4 py-3"}`}
            >
              {/* Title row */}
              <div className={`flex items-start gap-2 mb-1 ${compact ? "" : ""}`}>
                {sourceBadge(item.source)}
                <span className="text-[10px] font-mono text-white/90 leading-snug group-hover:text-nv-green transition-colors">
                  {item.title}
                </span>
              </div>

              {/* Meta */}
              {!compact && (
                <div className="flex items-center gap-2 ml-[28px] mb-1.5">
                  <span className="text-[9px] font-mono text-stealth-muted/60">{item.author}</span>
                  <span className="text-stealth-border/40">|</span>
                  <span className="text-[9px] font-mono text-stealth-muted/50">
                    {formatTimestamp(item.timestamp)}
                  </span>
                </div>
              )}

              {/* Body preview */}
              {!compact && (
                <p className="text-[10px] font-mono text-stealth-muted leading-relaxed ml-[28px]">
                  {highlightGenesisKeys(item.body_preview)}
                </p>
              )}
            </a>
          ))
        )}
      </div>

      {/* Footer */}
      {!compact && (
        <div className="px-4 py-1.5 border-t border-stealth-border bg-stealth-dark/30 flex items-center justify-between">
          <span className="text-[8px] font-mono text-stealth-muted/40">
            ggml-org/llama.cpp · GITHUB
          </span>
          {status === "online" && (
            <span className="text-[8px] font-mono text-nv-green/30">2h CACHE</span>
          )}
        </div>
      )}
    </div>
  );
}
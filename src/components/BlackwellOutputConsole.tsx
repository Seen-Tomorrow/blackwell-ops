import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

interface OutputLine {
  timestamp: string;
  content: string;
  style: string;
}

interface BlackwellOutputConsoleProps {
  onClose?: () => void;
  onDetachedChange?: (detached: boolean) => void;
  isOpen?: boolean;
  compact?: boolean;
  /** When the docked bar opens the console, jump to this tab (once per open). */
  openWithCategory?: OutputConsoleCategory | null;
}

export const OUTPUT_CONSOLE_CATEGORIES = ["engines", "utils", "foundry", "error", "general", "debug"] as const;
export type OutputConsoleCategory = typeof OUTPUT_CONSOLE_CATEGORIES[number];

type Category = OutputConsoleCategory;

export function parseOutputConsoleCategory(value: string): OutputConsoleCategory | null {
  const lower = value.toLowerCase();
  return (OUTPUT_CONSOLE_CATEGORIES as readonly string[]).includes(lower)
    ? (lower as OutputConsoleCategory)
    : null;
}

export const OUTPUT_CONSOLE_CATEGORY_LABELS: Record<Category, string> = {
  engines: "Engines",
  utils: "Utils",
  foundry: "Foundry",
  error: "Error",
  general: "General",
  debug: "Debug",
};

const CATEGORY_LABELS = OUTPUT_CONSOLE_CATEGORY_LABELS;

/** RFC3339 or legacy ISO strings → local HH:MM:SS.mmm for display. */
export function formatConsoleTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (!Number.isNaN(parsed.getTime())) {
    const h = String(parsed.getHours()).padStart(2, "0");
    const m = String(parsed.getMinutes()).padStart(2, "0");
    const s = String(parsed.getSeconds()).padStart(2, "0");
    const ms = String(parsed.getMilliseconds()).padStart(3, "0");
    return `${h}:${m}:${s}.${ms}`;
  }
  if (timestamp.length >= 23) return timestamp.slice(11, 23);
  return timestamp;
}

function lineStyleClass(style: string, activeCategory: Category): string {
  if (activeCategory === "error") return "boc-line--error";
  switch (style) {
    case "Error": return "boc-line--error";
    case "Warning": return "boc-line--warning";
    case "Success": return "boc-line--success";
    case "Command": return "boc-line--command";
    case "Highlight": return "boc-line--highlight";
    default: return "boc-line--normal";
  }
}

const DETACHED_DEFAULT_SIZE = { width: 780, height: 460 };
const DETACHED_MIN_SIZE = { width: 420, height: 140 };

export default function BlackwellOutputConsole({
  onClose,
  onDetachedChange,
  isOpen = false,
  compact = false,
  openWithCategory = null,
}: BlackwellOutputConsoleProps) {
  const [activeCategory, setActiveCategory] = useState<Category>("engines");
  const wasOpenRef = useRef(false);
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDetached, setIsDetached] = useState(false);
  const [position, setPosition] = useState({ x: 80, y: 80 });
  const [detachedSize, setDetachedSize] = useState(DETACHED_DEFAULT_SIZE);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0 });
  const resizeRef = useRef({ startX: 0, startY: 0, startW: 0, startH: 0 });

  const pollInterval = useRef<number | null>(null);

  useEffect(() => {
    onDetachedChange?.(isDetached);
  }, [isDetached, onDetachedChange]);

  useEffect(() => {
    if (!isOpen) setIsDetached(false);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && !wasOpenRef.current && openWithCategory) {
      setActiveCategory(openWithCategory);
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, openWithCategory]);

  const handleClose = useCallback(() => {
    setIsDetached(false);
    onClose?.();
  }, [onClose]);

  const fetchBuffer = useCallback(async (category: Category, keepPrevious = false) => {
    if (!keepPrevious) setIsLoading(true);
    try {
      const data = await invoke<OutputLine[]>("get_blackwell_output_console_buffer_for_category", {
        category,
        limit: 900,
      });
      setLines(data || []);
    } catch (err) {
      console.error("[Blackwell] Fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchBuffer(activeCategory);
      pollInterval.current = window.setInterval(() => {
        fetchBuffer(activeCategory, true);
      }, 250);
    } else if (pollInterval.current) {
      clearInterval(pollInterval.current);
      pollInterval.current = null;
    }
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, [isOpen, activeCategory, fetchBuffer]);

  const clearCategory = async (cat: Category) => {
    await invoke("clear_blackwell_output_console_category", { category: cat });
    if (cat === activeCategory) setLines([]);
  };

  const clearAll = async () => {
    await invoke("clear_all_blackwell_output_console_buffers");
    setLines([]);
  };

  const saveCategory = (cat: Category) => {
    const content = lines.map(l => `[${formatConsoleTimestamp(l.timestamp)}] ${l.content}`).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `blackwell-${cat}-${new Date().toISOString().slice(0, 19)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clampDetachedSize = useCallback((width: number, height: number, pos = position) => {
    const maxW = Math.max(DETACHED_MIN_SIZE.width, window.innerWidth - pos.x - 20);
    const maxH = Math.max(DETACHED_MIN_SIZE.height, window.innerHeight - pos.y - 20);
    return {
      width: Math.max(DETACHED_MIN_SIZE.width, Math.min(maxW, width)),
      height: Math.max(DETACHED_MIN_SIZE.height, Math.min(maxH, height)),
    };
  }, [position]);

  const startDrag = (e: React.MouseEvent) => {
    if (!isDetached || isResizing) return;
    e.preventDefault();
    setIsDragging(true);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: position.x,
      initialY: position.y,
    };
  };

  const startResize = (e: React.MouseEvent) => {
    if (!isDetached) return;
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: detachedSize.width,
      startH: detachedSize.height,
    };
  };

  const doDrag = useCallback((e: MouseEvent) => {
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPosition((prev) => ({
      x: Math.max(20, Math.min(window.innerWidth - detachedSize.width - 20, dragRef.current.initialX + dx)),
      y: Math.max(20, Math.min(window.innerHeight - detachedSize.height - 20, dragRef.current.initialY + dy)),
    }));
  }, [detachedSize.width, detachedSize.height]);

  const doResize = useCallback((e: MouseEvent) => {
    const dw = e.clientX - resizeRef.current.startX;
    const dh = e.clientY - resizeRef.current.startY;
    setDetachedSize(clampDetachedSize(
      resizeRef.current.startW + dw,
      resizeRef.current.startH + dh,
    ));
  }, [clampDetachedSize]);

  const stopDrag = () => setIsDragging(false);
  const stopResize = () => setIsResizing(false);

  useEffect(() => {
    if (!isDragging) return;
    window.addEventListener("mousemove", doDrag);
    window.addEventListener("mouseup", stopDrag);
    return () => {
      window.removeEventListener("mousemove", doDrag);
      window.removeEventListener("mouseup", stopDrag);
    };
  }, [isDragging, doDrag]);

  useEffect(() => {
    if (!isResizing) return;
    window.addEventListener("mousemove", doResize);
    window.addEventListener("mouseup", stopResize);
    return () => {
      window.removeEventListener("mousemove", doResize);
      window.removeEventListener("mouseup", stopResize);
    };
  }, [isResizing, doResize]);

  useEffect(() => {
    if (!isDetached) return;
    const onWindowResize = () => {
      setPosition((prev) => ({
        x: Math.max(20, Math.min(window.innerWidth - detachedSize.width - 20, prev.x)),
        y: Math.max(20, Math.min(window.innerHeight - detachedSize.height - 20, prev.y)),
      }));
      setDetachedSize((prev) => clampDetachedSize(prev.width, prev.height));
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, [isDetached, detachedSize.width, detachedSize.height, clampDetachedSize]);

  if (!isOpen) return null;

  const panelHeight = compact ? undefined : "44vh";
  const panelMinHeight = compact ? undefined : "280px";

  const panel = (
    <div
      className={`blackwell-output-console flex flex-col text-[10px] font-mono ${
        isDetached
          ? "blackwell-output-console--detached fixed z-[110] rounded overflow-hidden"
          : "blackwell-output-console--docked fixed left-0 right-0 z-[40]"
      } ${isDetached && (isDragging || isResizing) ? "blackwell-output-console--interacting" : ""}`}
      style={{
        ...(isDetached
          ? {
              left: `${position.x}px`,
              top: `${position.y}px`,
              width: `${detachedSize.width}px`,
              height: `${detachedSize.height}px`,
              userSelect: isDragging || isResizing ? "none" : undefined,
              WebkitUserSelect: isDragging || isResizing ? "none" : undefined,
            } as React.CSSProperties
          : compact
            ? {}
            : {
                bottom: "var(--app-footer-h)",
                height: panelHeight,
                minHeight: panelMinHeight,
              }),
      }}
      onDragStart={(e) => e.preventDefault()}
    >
      <div
        className={`blackwell-output-console__header flex items-center justify-between px-4 tracking-[1.5px] text-[9px] cursor-grab active:cursor-grabbing ${compact ? "py-0.5" : "py-1"}`}
        onMouseDown={startDrag}
      >
        <div className="flex items-center gap-2">
          <span className={`font-bold ${compact ? "text-[8px]" : ""}`}>BLACKWELL OUTPUT CONSOLE</span>
          {!compact && <span className="boc-version-badge px-1.5 py-px text-[7px]">v0.9</span>}
        </div>

        <div className="flex items-center gap-1.5">
          {OUTPUT_CONSOLE_CATEGORIES.map(cat => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`boc-tab px-2 py-0.5 rounded-sm border text-[8px] transition-all ${
                cat === "error"
                  ? activeCategory === cat
                    ? "boc-tab--error-active"
                    : "boc-tab--error"
                  : activeCategory === cat
                    ? "boc-tab--active"
                    : "boc-tab--idle"
              }`}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          ))}

          <div className="boc-divider w-px h-3 mx-1" />

          <button onClick={() => clearCategory(activeCategory)} className="boc-action-btn boc-action-btn--clear" title="Clear tab">C</button>
          <button onClick={() => saveCategory(activeCategory)} className="boc-action-btn boc-action-btn--save" title="Save tab">S</button>
          <button onClick={() => void clearAll()} className="boc-action-btn boc-action-btn--clear" title="Clear all">ALL</button>

          {isDetached ? (
            <button onClick={() => setIsDetached(false)} className="boc-utility-btn px-2 py-0.5 text-[8px]">DOCK</button>
          ) : (
            <button onClick={() => setIsDetached(true)} className="boc-utility-btn px-2 py-0.5 text-[8px]">DETACH</button>
          )}

          <button onClick={handleClose} className="boc-close-btn px-2 py-0.5 text-[10px] ml-1">✕</button>
        </div>
      </div>

      <div className="blackwell-output-console__body flex-1 overflow-auto p-2 pb-4 text-[9.5px] leading-[1.35] custom-scrollbar min-h-0">
        {isLoading && <div className="boc-sync pl-1">SYNCING TELEMETRY...</div>}

        {!isLoading && lines.length === 0 && (
          <div className="boc-empty pl-1 italic">NO DATA IN CHANNEL</div>
        )}

        {lines.map((line, i) => (
          <div key={i} className={`boc-line py-[1px] whitespace-pre-wrap break-all ${lineStyleClass(line.style, activeCategory)}`}>
            <span className="boc-line__ts mr-1.5 select-none">[{formatConsoleTimestamp(line.timestamp)}]</span>
            {line.content}
          </div>
        ))}
      </div>

      <div className={`blackwell-output-console__footer px-3 flex items-center justify-between text-[7px] ${compact ? "h-4" : "h-5"}`}>
        <span>{lines.length} LINES • {activeCategory.toUpperCase()}</span>
        <span className="boc-refresh cursor-pointer" onClick={() => fetchBuffer(activeCategory)}>REFRESH</span>
      </div>

      {isDetached && (
        <div
          className="boc-resize-handle"
          onMouseDown={startResize}
          title="Drag to resize"
          aria-label="Resize console"
        />
      )}
    </div>
  );

  return createPortal(panel, document.body);
}
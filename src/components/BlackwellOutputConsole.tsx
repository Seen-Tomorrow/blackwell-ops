import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface OutputLine {
  timestamp: string;
  content: string;
  style: string;
}

interface BlackwellOutputConsoleProps {
  isPowerUser: boolean;
  onClose?: () => void;
  isOpen?: boolean;
  compact?: boolean;
}

const CATEGORIES = ["engines", "utils", "foundry", "error", "general", "debug"] as const;
type Category = typeof CATEGORIES[number];

const CATEGORY_LABELS: Record<Category, string> = {
  engines: "Engines",
  utils: "Utils",
  foundry: "Foundry",
  error: "Error",
  general: "General",
  debug: "Debug",
};

export default function BlackwellOutputConsole({ 
  isPowerUser, 
  onClose, 
  isOpen = false,
  compact = false
}: BlackwellOutputConsoleProps) {
  const [activeCategory, setActiveCategory] = useState<Category>("engines");
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDetached, setIsDetached] = useState(false);
  const [position, setPosition] = useState({ x: 80, y: 80 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0 });

  const pollInterval = useRef<number | null>(null);

  const fetchBuffer = useCallback(async (category: Category, keepPrevious = false) => {
    if (!isPowerUser) return;
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
  }, [isPowerUser]);

  // Live updating while open
  useEffect(() => {
    if (isOpen && isPowerUser) {
      fetchBuffer(activeCategory);
      pollInterval.current = window.setInterval(() => {
        fetchBuffer(activeCategory, true); // keep previous lines to avoid flicker
      }, 250); // ~4x per second - fluid, low cost when batched on backend
    } else if (pollInterval.current) {
      clearInterval(pollInterval.current);
      pollInterval.current = null;
    }
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, [isOpen, activeCategory, fetchBuffer, isPowerUser]);

  const clearCategory = async (cat: Category) => {
    await invoke("clear_blackwell_output_console_category", { category: cat });
    if (cat === activeCategory) setLines([]);
  };

  const clearAll = async () => {
    await invoke("clear_all_blackwell_output_console_buffers");
    setLines([]);
  };

  const saveCategory = (cat: Category) => {
    const content = lines.map(l => `[${l.timestamp}] ${l.content}`).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `blackwell-${cat}-${new Date().toISOString().slice(0, 19)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Drag handlers for detached mode
  const startDrag = (e: React.MouseEvent) => {
    if (!isDetached) return;
    setIsDragging(true);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: position.x,
      initialY: position.y,
    };
  };

  const doDrag = (e: MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPosition({
      x: Math.max(30, Math.min(window.innerWidth - 500, dragRef.current.initialX + dx)),
      y: Math.max(30, Math.min(window.innerHeight - 300, dragRef.current.initialY + dy)),
    });
  };

  const stopDrag = () => setIsDragging(false);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", doDrag);
      window.addEventListener("mouseup", stopDrag);
    }
    return () => {
      window.removeEventListener("mousemove", doDrag);
      window.removeEventListener("mouseup", stopDrag);
    };
  }, [isDragging]);

  if (!isPowerUser || !isOpen) return null;

  const displayLines = compact ? lines.slice(-5) : lines;

  const content = (
    <div 
      className={`flex flex-col border border-black bg-[#0a0f1a] text-[10px] font-mono ${isDetached ? "fixed z-[110] rounded overflow-hidden shadow-2xl shadow-black/80" : "w-full shadow-[0_-12px_32px_rgba(0,0,0,0.6)]"}`}
      style={{
        ...(isDetached 
          ? { left: `${position.x}px`, top: `${position.y}px`, width: "780px", height: compact ? "150px" : "460px" } 
          : { height: compact ? "150px" : "44vh", minHeight: compact ? "120px" : "280px" }),
        ...(isDetached ? { userSelect: 'none', WebkitUserSelect: 'none' } as React.CSSProperties : {})
      }}
      onMouseDown={(e) => {
        if (isDetached) {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      onDragStart={(e) => e.preventDefault()}
    >
      {/* Pro Tech Header */}
      <div 
        className={`flex items-center justify-between px-4 py-1 bg-[#b87a00] border-b border-black text-black tracking-[1.5px] text-[9px] cursor-grab active:cursor-grabbing ${compact ? "py-0.5" : ""}`}
        onMouseDown={startDrag}
      >
        <div className="flex items-center gap-2">
          <span className={`font-bold ${compact ? "text-[8px]" : ""}`}>BLACKWELL OUTPUT CONSOLE</span>
          {!compact && <span className="px-1.5 py-px text-[7px] border border-black/40 text-black">v0.9</span>}
        </div>

        <div className="flex items-center gap-1.5 text-white/70">
          {CATEGORIES.map(cat => (
            <button 
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-2 py-0.5 rounded-sm border text-[8px] transition-all ${cat === 'error'
                ? activeCategory === cat 
                  ? "bg-black border-red-500 text-red-400" 
                  : "text-red-700 border-black/20 hover:text-red-500 hover:border-red-800"
                : activeCategory === cat
                  ? "bg-black border-black text-[#b87a00]" 
                  : "border-black/20 hover:border-black/50 hover:text-black"}`}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          ))}

          <div className="w-px h-3 bg-black/20 mx-1" />

          <button onClick={() => clearCategory(activeCategory)} className="px-1 hover:text-red-400 text-black" title="Clear tab">C</button>
          <button onClick={() => saveCategory(activeCategory)} className="px-1 hover:text-emerald-400 text-black" title="Save tab">S</button>
          <button onClick={clearAll} className="px-1 hover:text-red-400 text-black" title="Clear all">ALL</button>

          {isDetached ? (
            <button onClick={() => setIsDetached(false)} className="px-2 py-0.5 text-[8px] border border-black/30 hover:border-black rounded">DOCK</button>
          ) : (
            <button onClick={() => setIsDetached(true)} className="px-2 py-0.5 text-[8px] border border-black/30 hover:border-black rounded">DETACH</button>
          )}

          <button onClick={onClose} className="px-2 py-0.5 hover:text-red-400 text-black text-[10px] ml-1">✕</button>
        </div>
      </div>

      {/* Output Area - Tech Aesthetic */}
      <div className="flex-1 overflow-auto p-2 bg-black/70 text-[9.5px] leading-[1.35] custom-scrollbar">
        {isLoading && <div className="text-cyan-400/50 pl-1">SYNCING TELEMETRY...</div>}
        
        {!isLoading && displayLines.length === 0 && (
          <div className="pl-1 text-white/25 italic">NO DATA IN CHANNEL</div>
        )}

        {displayLines.map((line, i) => {
          let cls = "text-white/75";
          if (line.style === "Error") cls = "text-red-400";
          else if (line.style === "Warning") cls = "text-amber-400";
          else if (line.style === "Success") cls = "text-emerald-400";
          else if (line.style === "Command") cls = "text-cyan-300";
          else if (line.style === "Highlight") cls = "text-yellow-300 font-semibold";

          return (
            <div key={i} className={`py-[1px] whitespace-pre-wrap break-all ${cls}`}>
              <span className="text-white/25 mr-1.5 select-none">[{line.timestamp.slice(11, 23)}]</span>
              {line.content}
            </div>
          );
        })}
      </div>

      <div className={`px-3 flex items-center justify-between text-[7px] border-t border-white/10 bg-[#0c1322] text-white/40 ${compact ? "h-4" : "h-5"}`}>
        <span>{displayLines.length} LINES • {activeCategory.toUpperCase()}</span>
        <span className="cursor-pointer hover:text-cyan-400 active:text-white" onClick={() => fetchBuffer(activeCategory)}>REFRESH</span>
      </div>
    </div>
  );

  return content;
}
import { motion } from "framer-motion";
import type { StackEntry } from "../lib/types";

interface MiniModelCardProps {
  entry: StackEntry;
  modelAuthor?: string;
  sourcePathLabel?: string;
  modelName: string;
  quant: string;
  sizeStr: string;
  isSelected: boolean;
  isNewLaunch: boolean;
  onSelect: (alias: string) => void;
}

export default function MiniModelCard({ entry, modelAuthor, modelName, quant, sizeStr, isSelected, isNewLaunch, onSelect }: MiniModelCardProps) {
  const isNvfp = quant.toLowerCase().includes("nvfp");

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1, borderColor: isNewLaunch ? ["#76B900", "#00FFFF", "#76B900"] : undefined }}
      transition={{ duration: 0.2, borderColor: { duration: 2, repeat: 0 } }}
      onClick={() => onSelect(entry.alias!)}
      className={`cursor-pointer rounded-sm p-1.5 border ${
        isSelected
          ?           "brushed-steel-card"
          : isNewLaunch
            ? "bg-black/40 hover:bg-black/60"
            : "bg-black/40 border-nv-green/40 hover:bg-black/60"
      }`}
    >
      {/* Top row: author (left), alias (right) */}
      <div className="flex items-center justify-between gap-1 mb-0.5">
        {modelAuthor && (
          <span className="text-[7px] font-mono text-stealth-muted truncate">{modelAuthor}</span>
        )}
        <span className="text-[6px] font-mono text-nv-green/80 shrink-0">{entry.alias}</span>
      </div>

      {/* Name (left) + quant badge (right) */}
      <div className="flex items-center justify-between gap-1">
        <span className={`text-[9px] font-mono truncate flex-shrink min-w-0 ${isSelected ? "text-nv-green" : "text-white"}`} title={modelName}>
          {modelName}
        </span>
        <span className={`text-[6px] font-mono px-0.5 py-0 rounded-sm shrink-0 ${isNvfp
          ? 'bg-nv-green/20 border border-nv-green/40 text-nv-green'
          : 'border border-telemetry-cyan/30 text-telemetry-cyan'}`}>
          {quant}
        </span>
      </div>

      {/* Size (bottom right) */}
      <div className="flex justify-end mt-0.5">
        <span className="text-[7px] font-mono text-stealth-muted">{sizeStr}</span>
      </div>
    </motion.div>
  );
}

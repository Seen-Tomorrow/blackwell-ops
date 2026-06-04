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
    <div
      onClick={() => onSelect(entry.alias!)}
      className={`cursor-pointer rounded-sm p-1.5 border mini-card-enter ${
        isSelected
           ? "brushed-steel-card"
           : isNewLaunch
             ? "bg-black/40 hover:bg-black/60 mini-card-new-pulse"
             : "bg-black/40 border-nv-green/40 hover:bg-black/60"
      }`}
    >
      <div className="flex items-center justify-between gap-1 mb-0.5">
        {modelAuthor && (
          <span className="text-[7px] font-mono text-stealth-muted truncate">{modelAuthor}</span>
        )}
        <span className="text-[6px] font-mono text-nv-green/80 shrink-0">{entry.alias}</span>
      </div>

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

      <div className="flex justify-end mt-0.5">
        <span className="text-[7px] font-mono text-stealth-muted">{sizeStr}</span>
      </div>
    </div>
  );
}

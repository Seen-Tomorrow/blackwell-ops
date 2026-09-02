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
           ? "gunmetal-card"
           : "mcard-mini--new mini-card-new-pulse"
      }`}
    >
      <div className="flex items-center justify-between gap-1 mb-0.5">
        {modelAuthor && (
          <span className="type-micro font-mono mcard-mini-author truncate">{modelAuthor}</span>
        )}
        <span className="type-hairline font-mono mcard-mini-alias shrink-0">{entry.alias}</span>
      </div>

      <div className="flex items-center justify-between gap-1">
        <span className={`type-label font-mono truncate flex-shrink min-w-0 ${isSelected ? "mcard-mini-name--selected" : "mcard-mini-name"}`} title={modelName}>
          {modelName}
        </span>
        <span className={`type-hairline font-mono px-0.5 py-0 rounded-sm shrink-0 ${isNvfp
          ? 'mcard-mini-quant--nvfp border'
          : 'mcard-mini-quant--cyan border'}`}>
          {quant}
        </span>
      </div>

      <div className="flex justify-end mt-0.5">
        <span className="type-micro font-mono mcard-mini-size">{sizeStr}</span>
      </div>
    </div>
  );
}

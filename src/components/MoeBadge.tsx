interface MoeBadgeProps {
  offloadMode?: string; // "moe_optimal" when active
  shouldHighlight?: boolean; // true when suggestion conditions are met
  onMoeSuggestionClick?: () => void;
  suggestionText?: string;
  className?: string;
}

export default function MoeBadge({ 
  offloadMode, shouldHighlight, onMoeSuggestionClick, suggestionText, className = ""
}: MoeBadgeProps) {
  
  const isGold = offloadMode === "moe_optimal";
  const state = isGold ? "badge-moe--gold" : shouldHighlight ? "badge-moe--suggest" : "badge-moe--idle";

  return (
    <div 
      className={`moe-badge-root badge-moe relative inline-flex flex-row items-center rounded-sm cursor-pointer px-[2px] shrink-0 ${state} ${className}`}
      title={
        isGold
          ? "MOE_OPTIMAL active — click to switch back to regular offload"
          : suggestionText || "Click to enable MOE_OPTIMAL offload"
      }
      onClick={(e) => {
        e.stopPropagation();
        onMoeSuggestionClick?.();
      }}
    >
      {/* Text column - centered */}
      <div className="flex flex-col items-center">
        <span className="badge-moe__word type-xl font-mono font-bold">MOE</span>
        <span className="badge-moe__sub type-label font-mono tracking-wider mt-0.5">MEMORY</span>
        <span className="badge-moe__sub badge-moe__sub--dim type-label font-mono tracking-widest -mt-0.5">OPTIMIZER</span>
      </div>

      
    </div>
  );
}
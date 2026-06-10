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
  const textColor = isGold ? "#451A03" : shouldHighlight ? "#FB923C" : "#6B7280";

  return (
    <div 
      className={`moe-badge-root relative inline-flex flex-row items-center rounded-sm cursor-pointer px-[2px] shrink-0 ${className} ${
        isGold
          ? "moe-badge-gold bg-gold-metallic"
          : shouldHighlight
            ? "moe-badge-suggest border border-dashed animate-dashed-border border-orange-400/80 hover:border-orange-300"
            : "border border-gray-500/40 hover:border-gray-500/60"
      }`}
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
        <span className="text-[18px] font-mono font-bold" style={{ color: textColor }}>MOE</span>
        <span className="text-[9px] font-mono tracking-wider mt-0.5" style={{ color: textColor }}>MEMORY</span>
        <span className="text-[9px] font-mono tracking-widest -mt-0.5" style={{ color: textColor, opacity: 0.7 }}>OPTIMIZER</span>
      </div>

      
    </div>
  );
}
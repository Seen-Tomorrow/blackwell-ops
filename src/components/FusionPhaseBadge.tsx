export default function FusionPhaseBadge({ phase }: { phase: string }) {
  return (
    <div className="fade-in">
      {phase && (
        <>
          {phase === "IDLE" && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-mono font-bold tracking-widest bg-stealth-muted/10 text-stealth-muted/60 border border-stone-500/20 rounded-sm">
              <span className="inline-block w-2 h-2 border rounded-full animate-spin phase-idle-pulse" />
              AWAITING REQUEST
            </span>
          )}
          {phase === "PP" && (
            <span className="inline-block px-2 py-0.5 text-[9px] font-mono font-bold tracking-widest bg-orange-400/20 text-orange-400 border border-orange-400/40 rounded-sm">
              PROMPT PROCESSING
            </span>
          )}
          {phase === "TG" && (
            <span className="inline-block px-2 py-0.5 text-[9px] font-mono font-bold tracking-widest bg-nv-green/20 text-nv-green border border-nv-green/40 rounded-sm">
              GENERATION
            </span>
          )}
        </>
      )}
    </div>
  );
}

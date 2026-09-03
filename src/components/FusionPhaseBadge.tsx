export default function FusionPhaseBadge({ phase }: { phase: string }) {
  return (
    <div className="fade-in">
      {phase && (
        <>
          {phase === "IDLE" && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 type-label font-mono font-bold tracking-widest fusion-phase-badge fusion-phase-badge--idle border rounded-sm">
              <span className="inline-block w-2 h-2 border rounded-full animate-spin phase-idle-pulse" />
              AWAITING REQUEST
            </span>
          )}
          {phase === "PP" && (
            <span className="inline-block px-2 py-0.5 type-label font-mono font-bold tracking-widest fusion-phase-badge fusion-phase-badge--pp border rounded-sm">
              PROMPT PROCESSING
            </span>
          )}
          {phase === "TG" && (
            <span className="inline-block px-2 py-0.5 type-label font-mono font-bold tracking-widest fusion-phase-badge fusion-phase-badge--tg border rounded-sm">
              GENERATION
            </span>
          )}
        </>
      )}
    </div>
  );
}

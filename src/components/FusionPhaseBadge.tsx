import { motion, AnimatePresence } from "framer-motion";

export default function FusionPhaseBadge({ phase }: { phase: string }) {
  return (
    <AnimatePresence mode="wait">
      {phase && (
        <motion.div
          key={phase}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0 }}
        >
          {phase === "IDLE" && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-mono font-bold tracking-widest bg-stealth-muted/10 text-stealth-muted/60 border border-stone-500/20 rounded-sm">
              <motion.span
                className="inline-block w-2 h-2 border rounded-full animate-spin"
                animate={{ scale: [0.8, 1.3, 0.8], borderColor: ['rgba(0,0,0,0.15)', '#76B900', 'rgba(0,0,0,0.15)'] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              />
              AWAITING REQUESTS
            </span>
          )}
          {phase === "PP" && (
            <span className="inline-block px-2 py-0.5 text-[9px] font-mono font-bold tracking-widest bg-orange-400/20 text-orange-400 border border-orange-400/40 rounded-sm">
              PP PROMPT
            </span>
          )}
          {phase === "TG" && (
            <span className="inline-block px-2 py-0.5 text-[9px] font-mono font-bold tracking-widest bg-nv-green/20 text-nv-green border border-nv-green/40 rounded-sm">
              TG GENERATE
            </span>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

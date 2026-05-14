import { motion, AnimatePresence } from "framer-motion";

export default function FusionPhaseBadge({ phase }: { phase: string }) {
  return (
    <AnimatePresence mode="wait">
      {phase && (
        <motion.div
          key={phase}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.15 }}
        >
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

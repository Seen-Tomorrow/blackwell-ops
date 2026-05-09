import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import NeuralNetworkAnimation from "./NeuralNetworkAnimation";

interface VramBadgeOverlayProps {
  engineAlias?: string;    // e.g., "ENGINE_1"
  enginePort?: number;      // e.g., 8080
}

export default function VramBadgeOverlay({ engineAlias, enginePort }: VramBadgeOverlayProps) {
  const [phase, setPhase] = useState<'marquee' | 'static'>('marquee');

  // Transition from marquee to static after 2 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setPhase('static');
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-50 bg-nv-green flex items-center justify-center"
    >
      {/* Neural network background animation (only in static phase) */}
      {phase === 'static' && (
        <NeuralNetworkAnimation />
      )}

      {/* Content overlay on top of neural network */}
      <AnimatePresence mode="wait">
        {phase === 'marquee' ? (
          // PHASE A: Animated marquee text
          <motion.div
            key="marquee"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, y: -20 }}
            className="overflow-hidden w-full relative z-10"
          >
            <motion.div
              animate={{ x: ["100%", "-100%"] }}
              transition={{ 
                duration: 3.3, 
                repeat: Infinity, 
                ease: "linear" 
              }}
              className="whitespace-nowrap flex items-center"
              style={{ fontSize: 'clamp(2.5rem, 9vh, 4.5rem)' }}
            >
              <span 
                className="font-mono font-bold tracking-widest text-black drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]"
              >
                ENGINE RUNNING
              </span>
            </motion.div>
          </motion.div>
        ) : (
          // PHASE B: Static alias + port display
          <motion.div
            key="static"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-2 relative z-10"
          >
            <span 
              style={{ fontSize: 'clamp(3rem, 10vh, 5rem)' }}
              className="font-mono font-bold text-black drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)] tracking-wider"
            >
              {engineAlias || "ENGINE"}
            </span>
            <span 
              style={{ fontSize: 'clamp(2rem, 7vh, 3.5rem)' }}
              className="font-mono font-semibold text-black/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
            >
              PORT {enginePort || "8080"}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

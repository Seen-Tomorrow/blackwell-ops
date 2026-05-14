import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { RadarRings, MatrixRain, OscilloscopeWave } from "./CrtAnimations";
import { sanitizeAlias } from "../lib/types";
import { useSlotTps } from "../hooks/useSlotTps";

interface VramBadgeOverlayProps {
  engineAlias?: string;
  enginePort?: number;
}

type AnimationMode = "radar" | "matrix" | "scope" | "off";

const MODES: { key: AnimationMode; label: string }[] = [
  { key: "radar", label: "RADAR" },
  { key: "matrix", label: "MATRIX" },
  { key: "scope", label: "SCOPE" },
  { key: "off", label: "OFF" },
];

const RENDER_MAP: Record<AnimationMode, () => JSX.Element> = {
  radar: RadarRings,
  matrix: MatrixRain,
  scope: OscilloscopeWave,
  off: () => <></>,
};

export default function VramBadgeOverlay({ engineAlias, enginePort }: VramBadgeOverlayProps) {
  const [phase, setPhase] = useState<'marquee' | 'static'>('marquee');
  const [animIdx, setAnimIdx] = useState(0);
  const currentMode = MODES[animIdx].key;
  const CurrentAnimation = RENDER_MAP[currentMode];
  const port = enginePort ?? 9090;
  const { slots } = useSlotTps(port);

  useEffect(() => {
    const timer = setTimeout(() => setPhase('static'), 2000);
    return () => clearTimeout(timer);
  }, []);

  const cycleAnim = () => setAnimIdx(i => (i + 1) % MODES.length);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute z-50 bg-nv-green overflow-hidden flex items-center justify-center rounded-xl"
      style={{ top: '6px', right: '6px', bottom: '6px', left: '6px' }}
    >
      {/* Background animation (static phase only) */}
      {phase === 'static' && <CurrentAnimation />}

      {/* CRT effect — scanlines + vignette */}
      <div className="pointer-events-none absolute inset-0 crt-overlay" />

      {/* Content */}
      <AnimatePresence mode="wait">
        {phase === 'marquee' ? (
          <motion.div
            key="marquee"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, y: -20 }}
            className="overflow-hidden w-full relative z-10"
          >
            <motion.div
              animate={{ x: ["100%", "-100%"] }}
              transition={{ duration: 3.3, repeat: Infinity, ease: "linear" }}
              className="whitespace-nowrap flex items-center"
              style={{ fontSize: 'clamp(2.5rem, 9vh, 4.5rem)' }}
            >
              <span className="font-mono font-bold tracking-widest text-black drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
                ENGINE RUNNING
              </span>
            </motion.div>
          </motion.div>
        ) : (
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
              {engineAlias ? sanitizeAlias(engineAlias).toUpperCase() : "ENGINE"}
            </span>
            <span
              style={{ fontSize: 'clamp(2rem, 7vh, 3.5rem)' }}
              className="font-mono font-semibold text-black/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
            >
              PORT {enginePort || "8080"}
            </span>

            {/* Real-time TPS readout */}
            <div className="flex gap-3 mt-1">
              {slots.map((s) => (
                <span
                  key={s.id}
                  className={`font-mono text-xs tracking-wider drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)] ${
                    s.isProcessing ? "text-black font-bold" : "text-black/40"
                  }`}
                >
                  S{s.id}: {s.tps > 0 ? `${s.tps.toFixed(1)} t/s` : "--"}{" "}
                  | ctx: {s.nDecoded}/{s.nCtx}{" "}
                  {s.tokensThisRequest > 0 && `(gen: ${s.tokensThisRequest})`}
                </span>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cycle button — bottom right */}
      <button
        onClick={cycleAnim}
        className="absolute bottom-1 right-1.5 z-20 px-1.5 py-0.5 text-[7px] font-mono tracking-wider text-black/40 hover:text-black/80 transition-colors border border-black/10 hover:border-black/30 rounded-sm bg-transparent"
        title={`Current: ${MODES[animIdx].label} — click to cycle`}
      >
        ◉ {MODES[animIdx].label}
      </button>
    </motion.div>
  );
}

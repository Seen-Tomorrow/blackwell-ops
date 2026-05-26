import { motion } from "framer-motion";
import { sanitizeAlias } from "../lib/types";

interface EngineBannerProps {
  slotIndex: number;
  alias?: string;
  providerName?: string;
  providerType?: string;
  status?: string;
  gpuMask?: string;
  buildInfo?: { version: string; buildDate: string; cudaVersion?: string };
}

function getBadgeColor(status?: string) {
  switch (status) {
    case "RUNNING": return { stroke: "text-nv-green/60", fill: "fill-nv-green/80" };
    case "LOADING": return { stroke: "text-telemetry-amber", fill: "fill-telemetry-amber" };
    case "ERROR":   return { stroke: "text-[#ff3333]", fill: "fill-[#ff3333]/80" };
    default:        return { stroke: "text-stealth-muted/60", fill: "fill-stealth-muted/80" };
  }
}

function resolveProviderName(providerName?: string): string | undefined {
  if (providerName && providerName.trim().length > 0) return providerName;
  return undefined;
}

export default function EngineBanner({ slotIndex, alias, providerName, providerType: _providerType, status, gpuMask, buildInfo }: EngineBannerProps) {
  const isIdle = status === "IDLE";
  const displayName = resolveProviderName(providerName);
  const hasProvider = !!displayName && displayName.trim().length > 0;
  const badgeColor = getBadgeColor(status);

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
      className="relative overflow-hidden"
    >
      {/* Background gradient layers */}
      <div className="absolute inset-0 bg-gradient-to-r from-nv-green/5 via-transparent to-telemetry-amber/5" />


      {/* Animated corner accents */}
      <div className="absolute top-0 left-0 w-6 h-6">
        <svg viewBox="0 0 24 24" fill="none" className="w-full h-full text-nv-green/40">
          <path d="M0 8 L0 0 L8 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
        </svg>
      </div>
      <div className="absolute top-0 right-0 w-6 h-6">
        <svg viewBox="0 0 24 24" fill="none" className="w-full h-full text-nv-green/40">
          <path d="M16 0 L24 0 L24 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
        </svg>
      </div>
      <div className="absolute bottom-0 left-0 w-6 h-6">
        <svg viewBox="0 0 24 24" fill="none" className="w-full h-full text-nv-green/40">
          <path d="M0 16 L0 24 L8 24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
        </svg>
      </div>
      <div className="absolute bottom-0 right-0 w-6 h-6">
        <svg viewBox="0 0 24 24" fill="none" className="w-full h-full text-nv-green/40">
          <path d="M16 24 L24 24 L24 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
        </svg>
      </div>

      {/* Top accent line */}
      <div className="absolute top-0 left-8 right-8 h-[1px] bg-gradient-to-r from-transparent via-nv-green/30 to-transparent" />

      {/* Content */}
      <div className="relative flex items-center justify-between px-6 py-4">
        {/* Left: Slot ID with circuit motif */}
        <div className="flex items-center gap-3">
          {/* Hexagonal slot badge */}
          <div className="relative">
            <svg width="34" height="34" viewBox="0 0 28 28" fill="none" className={badgeColor.stroke}>
              <path
                d="M14 2 L24 8 L24 20 L14 26 L4 20 L4 8 Z"
                stroke="currentColor"
                strokeWidth="1"
                fill="none"
              />
              <motion.text
                x="14"
                y="17"
                textAnchor="middle"
                dominantBaseline="central"
                className={badgeColor.fill}
                fontSize="13"
                fontFamily="monospace"
                fontWeight="bold"
                animate={status === "LOADING" ? { opacity: [0.4, 1, 0.4] } : {}}
                transition={status === "LOADING" ? { duration: 1.5, repeat: Infinity, ease: "easeInOut" } : {}}
              >
                {slotIndex + 1}
              </motion.text>
            </svg>
          </div>

          {/* Slot label */}
          <div className="flex flex-col">
            <span className="text-[9px] font-mono text-stealth-muted tracking-[0.2em] uppercase">
              Engine Slot {gpuMask ? `| GPU:${gpuMask}` : ""}
            </span>
            <span className="text-xs font-mono text-white/90 tracking-wider">
               #{alias ? sanitizeAlias(alias).toUpperCase() : String(slotIndex + 1).padStart(2, "0")}
             </span>
          </div>
        </div>

        {/* Center: Provider name with cyberpunk styling */}
        {!isIdle && hasProvider ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="flex items-center gap-3"
          >
            {/* Provider badge */}
            <div className="relative px-3 py-1 rounded-sm whitespace-nowrap">
              <div className="absolute inset-0 bg-nv-green/5 border border-nv-green/20 rounded-sm" />
              <div className="relative flex items-center gap-1.5">
                {/* Pulsing dot */}
                <motion.span
                  animate={{ opacity: [0.4, 1, 0.4] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                  className="inline-block w-1 h-1 rounded-full bg-nv-green/80"
                />
                <span className="text-[10px] font-mono text-nv-green tracking-wider">
                  {displayName}
                </span>
              </div>
            </div>

            {/* Divider */}
            <svg width="24" height="8" viewBox="0 0 24 8" fill="none" className="text-stealth-muted/20 shrink-0">
              <path d="M0 4 L24 4" stroke="currentColor" strokeWidth="0.5" />
            </svg>
          </motion.div>
        ) : null}

        {/* Right: ENV block + Status indicator */}
        <div className="flex items-center gap-3">
          {hasProvider && status === "RUNNING" && buildInfo ? (
            <motion.div
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3, duration: 0.4 }}
              className="flex items-center gap-2 px-2 py-1 rounded-sm border border-stealth-muted/10 bg-stealth-dark/50 whitespace-nowrap"
            >
              <span className="text-[8px] font-mono text-stealth-muted/60">
                build {buildInfo.version}
                 {buildInfo.cudaVersion ? ` @ CUDA ${buildInfo.cudaVersion}` : ""}
              </span>
            </motion.div>
          ) : null}
        </div>
      </div>

      {/* Bottom accent line */}
      <div className="absolute bottom-0 left-8 right-8 h-[1px] bg-gradient-to-r from-transparent via-stealth-muted/10 to-transparent" />
    </motion.div>
  );
}

import { motion } from "framer-motion";
import { useFusionData } from "../hooks/useFusionData";
import FusionOverlay from "./FusionOverlay";

interface FusionVramBadgeOverlayProps {
  engineAlias?: string;
  enginePort?: number;
}

export default function FusionVramBadgeOverlay({ engineAlias, enginePort }: FusionVramBadgeOverlayProps) {
  const { getEngine } = useFusionData();
  const fusion = engineAlias ? getEngine(engineAlias) : null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute z-50 fusion-eink-bg overflow-hidden flex items-center justify-center rounded-xl border border-stealth-border p-[5px]"
      style={{ top: '1px', right: '1px', bottom: '1px', left: '1px' }}
    >
      <FusionOverlay
        alias={engineAlias}
        enginePort={enginePort}
        fusion={fusion}
      />
    </motion.div>
  );
}

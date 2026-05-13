import { motion } from "framer-motion";

/**
 * Radar concentric rings expanding from center.
 */
export function RadarRings() {
  const rings = Array.from({ length: 4 }, (_, i) => ({
    id: i,
    delay: i * 0.8,
  }));

  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
      {rings.map((ring) => (
        <motion.circle
          key={ring.id}
          cx="50"
          cy="50"
          r="0"
          fill="none"
          stroke="#000000"
          strokeWidth="0.5"
          initial={{ opacity: 0.6, r: 0 }}
          animate={{
            r: [0, 48],
            opacity: [0.6, 0],
          }}
          transition={{
            duration: 2.5,
            repeat: Infinity,
            delay: ring.delay,
            ease: "easeOut",
          }}
        />
      ))}
    </svg>
  );
}

/**
 * Matrix-style vertical binary rain — columns of varying-length binary strings falling.
 */
export function MatrixRain() {
  const columns = Array.from({ length: 24 }, (_, i) => ({
    id: i,
    x: 1 + i * 4.1,
    speed: 2.5 + (i % 5) * 0.6,
    delay: (i * 0.3) % 4,
    length: 3 + (i % 7),
  }));

  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
      {columns.map((col) => {
        const binaryStr = Array.from({ length: col.length }, () => (Math.random() > 0.5 ? "1" : "0")).join("");
        return (
          <motion.text
            key={col.id}
            x={col.x}
            fill="#000000"
            fontSize="3"
            fontFamily="monospace"
            writingMode="vertical-rl"
            initial={{ y: -4, opacity: 0 }}
            animate={{
              y: [-4, 108],
              opacity: [0, 0.35, 0.35, 0],
            }}
            transition={{
              duration: col.speed,
              repeat: Infinity,
              delay: col.delay,
              ease: "linear",
            }}
          >
            {binaryStr}
          </motion.text>
        );
      })}
    </svg>
  );
}

/**
 * Oscilloscope waveform — animated sine wave across the screen.
 */
export function OscilloscopeWave() {
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 200 100" preserveAspectRatio="none">
      {[25, 50, 75].map((y) => (
        <line key={y} x1="0" y1={y} x2="200" y2={y} stroke="#000000" strokeWidth="0.2" opacity="0.1" />
      ))}
      {[50, 100, 150].map((x) => (
        <line key={x} x1={x} y1="0" x2={x} y2="100" stroke="#000000" strokeWidth="0.2" opacity="0.1" />
      ))}

      <motion.path
        fill="none"
        stroke="#000000"
        strokeWidth="1"
        opacity="0.4"
        initial={{ d: "M0,50 Q25,20 50,50 T100,50 T150,50 T200,50" }}
        animate={{
          d: [
            "M0,50 Q25,20 50,50 T100,50 T150,50 T200,50",
            "M0,50 Q25,80 50,50 T100,50 T150,50 T200,50",
            "M0,50 Q25,20 50,50 T100,50 T150,50 T200,50",
          ],
        }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
      />

      <motion.path
        fill="none"
        stroke="#000000"
        strokeWidth="0.5"
        opacity="0.2"
        initial={{ d: "M0,50 Q30,35 60,50 T120,50 T180,50 T200,50" }}
        animate={{
          d: [
            "M0,50 Q30,35 60,50 T120,50 T180,50 T200,50",
            "M0,50 Q30,65 60,50 T120,50 T180,50 T200,50",
            "M0,50 Q30,35 60,50 T120,50 T180,50 T200,50",
          ],
        }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      />

      <motion.circle
        r="1.5"
        fill="#000000"
        opacity="0.6"
        animate={{ cx: [0, 200], cy: [50, 30, 70, 50] }}
        transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
      />
    </svg>
  );
}

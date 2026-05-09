import { motion } from "framer-motion";

interface NeuralNetworkAnimationProps {
  gpuCount?: number;    // Number of GPUs to connect (default: 2)
}

/**
 * Complex neural network synapse animation between multiple GPUs.
 * Features:
 * - GPU nodes arranged in arc pattern with pulsing glow rings
 * - Fully connected mesh of synapse connections
 * - Bidirectional pulse packets traveling along all connections
 * - Randomized timing for organic "firing" effect
 * - Background ambient particles for depth
 */
export default function NeuralNetworkAnimation({ gpuCount = 2 }: NeuralNetworkAnimationProps) {
  // Generate GPU node positions in arc pattern
  const nodes = Array.from({ length: gpuCount }, (_, i) => {
    const angle = (i / Math.max(gpuCount - 1, 1)) * Math.PI + Math.PI / 6;
    return {
      id: i,
      x: 50 + Math.cos(angle) * 35,
      y: 50 + Math.sin(angle) * 20,
    };
  });

  // Generate all pairwise connections (fully connected mesh)
  const connections = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const length = Math.sqrt(dx * dx + dy * dy);
      connections.push({ 
        from: nodes[i], 
        to: nodes[j],
        length,
        angle: Math.atan2(dy, dx)
      });
    }
  }

  return (
    <svg 
      className="absolute inset-0 w-full h-full pointer-events-none opacity-70"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Gradients and filters */}
      <defs>
        {/* Node glow gradient - black to transparent */}
        <radialGradient id="nodeGlow">
          <stop offset="0%" stopColor="#000000" stopOpacity="0.9"/>
          <stop offset="30%" stopColor="#1a1a1a" stopOpacity="0.4"/>
          <stop offset="60%" stopColor="#2d2d2d" stopOpacity="0.15"/>
          <stop offset="100%" stopColor="#000000" stopOpacity="0"/>
        </radialGradient>

        {/* Synapse line gradient */}
        <linearGradient id="synapseLine">
          <stop offset="0%" stopColor="#000000" stopOpacity="0.6"/>
          <stop offset="50%" stopColor="#2d2d2d" stopOpacity="0.3"/>
          <stop offset="100%" stopColor="#000000" stopOpacity="0.4"/>
        </linearGradient>

        {/* Pulse gradient - bright center to transparent edges */}
        <radialGradient id="pulseGradient">
          <stop offset="0%" stopColor="#000000" stopOpacity="1"/>
          <stop offset="50%" stopColor="#1a1a1a" stopOpacity="0.6"/>
          <stop offset="100%" stopColor="#000000" stopOpacity="0"/>
        </radialGradient>

        {/* Glow filter for pulses */}
        <filter id="pulseGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="0.8" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>

        {/* Ambient particle gradient */}
        <radialGradient id="particleGrad">
          <stop offset="0%" stopColor="#000000" stopOpacity="0.4"/>
          <stop offset="100%" stopColor="#000000" stopOpacity="0"/>
        </radialGradient>
      </defs>

      {/* Ambient background particles for depth */}
      {Array.from({ length: 20 }).map((_, i) => (
        <motion.circle
          key={`particle-${i}`}
          cx={10 + Math.random() * 80}
          cy={10 + Math.random() * 80}
          r={0.3 + Math.random() * 0.5}
          fill="url(#particleGrad)"
          initial={{ opacity: 0 }}
          animate={{ 
            opacity: [0, 0.4, 0],
            r: [0.3, 0.8, 0.3]
          }}
          transition={{
            duration: 2 + Math.random() * 3,
            repeat: Infinity,
            delay: Math.random() * 5
          }}
        />
      ))}

      {/* Synapse connections between all GPU pairs */}
      {connections.map((conn, idx) => (
        <g key={`connection-${idx}`}>
          {/* Static connection line - faint background path */}
          <line
            x1={conn.from.x}
            y1={conn.from.y}
            x2={conn.to.x}
            y2={conn.to.y}
            stroke="url(#synapseLine)"
            strokeWidth="0.4"
            opacity="0.35"
          />

          {/* Forward pulse - travels from GPU i to GPU j */}
          <motion.circle
            r="1.8"
            fill="url(#pulseGradient)"
            filter="url(#pulseGlow)"
            initial={{ 
              cx: conn.from.x, 
              cy: conn.from.y,
              opacity: 0.9
            }}
            animate={{
              cx: [conn.from.x, conn.to.x],
              cy: [conn.from.y, conn.to.y],
              opacity: [0.9, 0.4, 0.9],
              r: [1.2, 2.2, 1.2]
            }}
            transition={{
              duration: 1.8 + Math.random() * 1.2,
              repeat: Infinity,
              ease: "easeInOut",
              delay: (idx * 0.4) % 3
            }}
          />

          {/* Backward pulse - travels from GPU j to GPU i (bidirectional) */}
          <motion.circle
            r="1.4"
            fill="url(#pulseGradient)"
            filter="url(#pulseGlow)"
            initial={{ 
              cx: conn.to.x, 
              cy: conn.to.y,
              opacity: 0.7
            }}
            animate={{
              cx: [conn.to.x, conn.from.x],
              cy: [conn.to.y, conn.from.y],
              opacity: [0.7, 0.3, 0.7],
              r: [1, 1.8, 1]
            }}
            transition={{
              duration: 2 + Math.random() * 1.5,
              repeat: Infinity,
              ease: "easeInOut",
              delay: (idx * 0.4 + 0.9) % 3
            }}
          />

          {/* Secondary pulse wave - smaller, faster */}
          <motion.circle
            r="0.8"
            fill="#000000"
            opacity="0.6"
            initial={{ 
              cx: conn.from.x, 
              cy: conn.from.y,
              opacity: 0.5
            }}
            animate={{
              cx: [conn.from.x, conn.to.x],
              cy: [conn.from.y, conn.to.y],
              opacity: [0.5, 0.2, 0.5]
            }}
            transition={{
              duration: 1.2 + Math.random() * 0.8,
              repeat: Infinity,
              ease: "linear",
              delay: (idx * 0.3 + 0.6) % 2
            }}
          />
        </g>
      ))}

      {/* GPU nodes with pulsing effects */}
      {nodes.map((node) => (
        <g key={`node-${node.id}`}>
          {/* Outermost glow ring - slow pulse */}
          <motion.circle
            cx={node.x}
            cy={node.y}
            r="8"
            fill="none"
            stroke="#000000"
            strokeWidth="0.2"
            initial={{ opacity: 0.2 }}
            animate={{ 
              r: [6, 10, 6],
              opacity: [0.2, 0.4, 0.2]
            }}
            transition={{
              duration: 3,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />

          {/* Middle glow ring - medium pulse */}
          <motion.circle
            cx={node.x}
            cy={node.y}
            r="5"
            fill="none"
            stroke="#000000"
            strokeWidth="0.3"
            initial={{ opacity: 0.3 }}
            animate={{ 
              r: [4, 7, 4],
              opacity: [0.3, 0.5, 0.3]
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: "easeInOut",
              delay: 0.5
            }}
          />

          {/* Inner glow ring - fast pulse */}
          <motion.circle
            cx={node.x}
            cy={node.y}
            r="3"
            fill="none"
            stroke="#000000"
            strokeWidth="0.4"
            initial={{ opacity: 0.4 }}
            animate={{ 
              r: [2.5, 4.5, 2.5],
              opacity: [0.4, 0.6, 0.4]
            }}
            transition={{
              duration: 1.5,
              repeat: Infinity,
              ease: "easeInOut",
              delay: 1
            }}
          />

          {/* Core node - solid with glow */}
          <circle
            cx={node.x}
            cy={node.y}
            r="2.5"
            fill="url(#nodeGlow)"
            stroke="#000000"
            strokeWidth="0.6"
          />

          {/* Center dot - brightest point */}
          <motion.circle
            cx={node.x}
            cy={node.y}
            r="1"
            fill="#000000"
            animate={{ opacity: [0.8, 1, 0.8] }}
            transition={{
              duration: 1,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
        </g>
      ))}
    </svg>
  );
}

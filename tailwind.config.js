/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        stealth: {
          black: "#000000",
          dark: "#0a0a0f",
          panel: "#111118",
          border: "#1a1a2e",
          muted: "#4a4a5a",
        },
        nv: {
          green: "#76B900",
          dim: "#4d7a00",
        },
        telemetry: {
          amber: "#FFB800",
          red: "#ff3333",
          cyan: "#00e5ff",
        },
        reactor: {
          coolant: "#0066ff",
          ripple: "#00e5ff",
          magma: "#ff2200",
          core: "#0a1628",
          rod: "#1a3a5c",
          plasma: "#00ff88",
          critical: "#ff4400",
        },
        'neon-magenta': '#ff00aa',
        'electric-blue': '#4488ff',
        'cyber-purple': '#8855ff',
        'depth-black': '#050510',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Roboto Mono"', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "glow-green": "glowGreen 2s ease-in-out infinite alternate",
        "coolant-ripple": "coolantRipple 1.5s ease-in-out infinite",
        "rod-insert": "rodInsert 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) forwards",
        "heat-haze": "heatHaze 0.3s ease-in-out infinite alternate",
        "vibrate-card": "vibrateCard 0.15s linear infinite",
        "bubble-rise": "bubbleRise 2s ease-in infinite",
        "core-pulse": "corePulse 2s ease-in-out infinite",
        "plasma-flow": "plasmaFlow 3s linear infinite",
        'holographic': 'holographicShimmer 3s linear infinite',
        'neon-pulse': 'neonPulse 2s ease-in-out infinite',
        'glitch-flicker': 'glitchFlicker 4s linear infinite',
        'vram-fill': 'vramFill 1.5s ease-out forwards',
        'card-glow-cyan': 'cardGlowCyan 3s ease-in-out infinite',
        'card-glow-magenta': 'cardGlowMagenta 3s ease-in-out infinite',
      },
      keyframes: {
        glowGreen: {
          "0%": { boxShadow: "0 0 5px rgba(118, 185, 0, 0.3)" },
          "100%": { boxShadow: "0 0 20px rgba(118, 185, 0, 0.6)" },
        },
        coolantRipple: {
          "0%, 100%": { transform: "translateX(0) scaleY(1)", opacity: "0.7" },
          "25%": { transform: "translateX(-3px) scaleY(1.02)", opacity: "0.85" },
          "50%": { transform: "translateX(3px) scaleY(0.98)", opacity: "0.75" },
          "75%": { transform: "translateX(-2px) scaleY(1.01)", opacity: "0.8" },
        },
        rodInsert: {
          "0%": { transform: "translateY(-40px) scale(0.9)", opacity: "0.3" },
          "60%": { transform: "translateY(4px) scale(1.02)", opacity: "0.9" },
          "100%": { transform: "translateY(0) scale(1)", opacity: "1" },
        },
        heatHaze: {
          "0%": { filter: "blur(0px) brightness(1)" },
          "100%": { filter: "blur(0.5px) brightness(1.1)" },
        },
        vibrateCard: {
          "0%, 100%": { transform: "translateX(0) translateY(0)" },
          "25%": { transform: "translateX(-1px) translateY(1px)" },
          "50%": { transform: "translateX(1px) translateY(-1px)" },
          "75%": { transform: "translateX(-1px) translateY(-1px)" },
        },
        bubbleRise: {
          "0%": { transform: "translateY(0) scale(1)", opacity: "0.8" },
          "100%": { transform: "translateY(-60px) scale(0.3)", opacity: "0" },
        },
        corePulse: {
          "0%, 100%": { boxShadow: "0 0 20px rgba(0, 102, 255, 0.2)" },
          "50%": { boxShadow: "0 0 40px rgba(0, 102, 255, 0.4)" },
        },
        plasmaFlow: {
          "0%": { strokeDashoffset: "0" },
          "100%": { strokeDashoffset: "100" },
        },
        holographicShimmer: {
          '0%': { backgroundPosition: '-200% center' },
          '100%': { backgroundPosition: '200% center' },
        },
        neonPulse: {
          '0%, 100%': { boxShadow: '0 0 8px rgba(118, 185, 0, 0.4), 0 0 20px rgba(118, 185, 0, 0.1)' },
          '50%': { boxShadow: '0 0 16px rgba(118, 185, 0, 0.7), 0 0 40px rgba(118, 185, 0, 0.2)' },
        },
        glitchFlicker: {
          '0%, 90%, 100%': { opacity: '1' },
          '92%': { opacity: '0.6' },
          '94%': { opacity: '1' },
          '96%': { opacity: '0.8' },
        },
        vramFill: {
          '0%': { width: '0%' },
          '100%': { width: 'var(--vram-pct, 50%)' },
        },
        cardGlowCyan: {
          '0%, 100%': { boxShadow: '0 0 6px rgba(0, 229, 255, 0.3), inset 0 0 6px rgba(0, 229, 255, 0.05)' },
          '50%': { boxShadow: '0 0 14px rgba(0, 229, 255, 0.6), inset 0 0 10px rgba(0, 229, 255, 0.1)' },
        },
        cardGlowMagenta: {
          '0%, 100%': { boxShadow: '0 0 6px rgba(255, 0, 170, 0.3), inset 0 0 6px rgba(255, 0, 170, 0.05)' },
          '50%': { boxShadow: '0 0 14px rgba(255, 0, 170, 0.6), inset 0 0 10px rgba(255, 0, 170, 0.1)' },
        },
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
/**
 * Layout utilities only for chrome colors — theme paint lives in CSS variables
 * from app-themes.ts (applyAppTheme). Prefer var(--theme-*) / semantic classes
 * over hard-coded palette for anything that should switch with the theme picker.
 *
 * stealth / nv / telemetry map to CSS vars so existing utility classes still
 * resolve; reactor/* leftovers kept only if any TSX still references them.
 */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        stealth: {
          black: "var(--color-stealth-black, #000000)",
          dark: "var(--theme-bg, #0a0a0f)",
          panel: "var(--theme-panel, #111118)",
          border: "var(--theme-border, #1a1a2e)",
          muted: "var(--theme-text-muted, #4a4a5a)",
        },
        nv: {
          green: "var(--theme-accent, #76B900)",
          dim: "var(--theme-accent-dim, #4d7a00)",
        },
        telemetry: {
          amber: "var(--theme-secondary-bright, #FFB800)",
          red: "#ff3333",
          cyan: "var(--theme-accent-bright, #00e5ff)",
        },
        // Semantic aliases for new code
        theme: {
          bg: "var(--theme-bg)",
          text: "var(--theme-text)",
          muted: "var(--theme-text-muted)",
          panel: "var(--theme-panel)",
          border: "var(--theme-border)",
          accent: "var(--theme-accent)",
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Roboto Mono"', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};

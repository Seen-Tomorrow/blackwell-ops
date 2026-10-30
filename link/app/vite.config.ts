import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The flyout is a compact window; the dev server is deliberately separate from
// the main Blackwell OPS Vite server (1420/1421).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1422,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    target: "chrome110",
    outDir: "dist",
    emptyOutDir: true,
  },
});

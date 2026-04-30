import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST || "0.0.0.0";

// https://tauri.app/start
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev`/`tauri serve`
  server: {
    host,
    port: 1420,
  },

  build: {
    target: "esnext",
    minify: true,
  },
}));

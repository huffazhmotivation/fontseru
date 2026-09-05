import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors the "@/*" -> "src/*" path mapping in tsconfig.app.json so
    // Vite resolves "@/..." imports at dev/build time.
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: false,
  },
  preview: {
    host: "0.0.0.0",
    port: 3000,
  },
  build: {
    target: "es2020",
    // Sourcemaps are only useful for local debugging; shipping them makes
    // every deploy noticeably bigger and slower to upload/serve for no
    // benefit to end users. Turn them back to `true` temporarily if you
    // need to debug a production-only bug in the browser devtools.
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split the few genuinely heavy, occasionally-used libraries into
        // their own cacheable chunks instead of letting them inflate the
        // single main bundle that has to be downloaded and parsed before
        // the editor can render at all. Browsers fetch/parse these in
        // parallel, and — because they rarely change — they stay cached
        // across app updates instead of being re-downloaded every time.
        manualChunks: {
          "vendor-opentype": ["opentype.js"],
          "vendor-imagetrace": ["imagetracerjs"],
          "vendor-pdf": ["jspdf"],
          "vendor-supabase": ["@supabase/supabase-js"],
        },
      },
    },
  },
});

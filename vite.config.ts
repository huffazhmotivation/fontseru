import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Service-worker update lifecycle only — FontSeru already ships its own
    // <link rel="manifest"> + public/site.webmanifest with the real icons/
    // branding, so `manifest: false` leaves that untouched and this plugin
    // only generates/versions the service worker.
    VitePWA({
      manifest: false,
      registerType: "prompt",
      // We register the service worker ourselves via
      // `virtual:pwa-register/react` in src/components/UpdatePrompt.tsx, so
      // the app controls exactly when the "update available" popup shows
      // instead of the plugin injecting its own registration script.
      injectRegister: false,
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        globPatterns: ["**/*.{js,css,html,svg,png,woff,woff2,ico}"],
      },
      devOptions: {
        // Keep local `npm run dev` behaving exactly like before — the
        // update-checking machinery only matters for real deploys.
        enabled: false,
      },
    }),
  ],
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

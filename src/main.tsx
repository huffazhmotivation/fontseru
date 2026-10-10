import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { PrayerReminder } from "./prayer/PrayerReminder";
import "./styles/app.css";
import "./mode/modeTabs.css";
// Harus terakhir: perbaikan layar penuh, safe-area & target sentuh iPad.
import "./styles/tablet-touch.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found in index.html");
}

// Safety net for Design mode (DesignSeru is an iframe of /design/index.html).
// A service worker from before that folder existed answers the iframe's
// navigation with THIS app's index.html; this app would then open Design mode
// again inside the iframe, and so on — the page sat on "Memperbarui…" forever.
// If we are running framed at /design/, we are that wrong page: drop the stale
// service workers/caches and reload once so the real design app is fetched.
const framedAtDesign = window.top !== window.self && window.location.pathname.includes("/design/");
if (framedAtDesign) {
  const KEY = "fs-design-frame-recover";
  void (async () => {
    try {
      if (sessionStorage.getItem(KEY)) return;
      sessionStorage.setItem(KEY, "1");
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
      if ("caches" in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
    } catch {
      /* best effort */
    }
    window.location.reload();
  })();
} else createRoot(rootEl).render(
  <StrictMode>
    <AuthProvider>
      <App />
      {/* Mounted once, outside <App/>'s own Font/Motion mode branching, so
          a "new version available" popup can appear no matter which mode
          the user is in. */}
      <UpdatePrompt />
      {/* Pengingat sholat: juga di luar <App/> agar aktif di mode Font, Design, dan Motion. */}
      <PrayerReminder />
    </AuthProvider>
  </StrictMode>
);

// Splash dari index.html: lepas begitu React sudah menggambar frame pertamanya.
requestAnimationFrame(() => requestAnimationFrame(() => {
  const splash = document.getElementById("fs-splash");
  if (!splash) return;
  splash.classList.add("fs-splash-out");
  window.setTimeout(() => splash.remove(), 250);
}));

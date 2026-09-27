import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ChunkLoadRecovery } from "./components/ChunkLoadRecovery";
import "./styles/app.css";
import "./mode/modeTabs.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    {/* Catches any crash in the tree below — most importantly a failed
        dynamic import() of a stale, no-longer-cached chunk after a
        deploy — and shows a recovery card (auto-reloading when it can)
        instead of leaving a blank white screen. See AppErrorBoundary and
        staleBuildRecovery.ts for the full story. */}
    <AppErrorBoundary>
      {/* Listens for the same kind of failure surfacing as an unhandled
          promise rejection / Vite's own preload-error event, rather than
          a React render throw — belt-and-braces alongside the boundary
          above. */}
      <ChunkLoadRecovery />
      <AuthProvider>
        <App />
        {/* Mounted once, outside <App/>'s own Font/Motion mode branching, so
            a "new version available" popup can appear no matter which mode
            the user is in. */}
        <UpdatePrompt />
      </AuthProvider>
    </AppErrorBoundary>
  </StrictMode>
);

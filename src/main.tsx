import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { UpdatePrompt } from "./components/UpdatePrompt";
import "./styles/app.css";
import "./mode/modeTabs.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <AuthProvider>
      <App />
      {/* Mounted once, outside <App/>'s own Font/Motion mode branching, so
          a "new version available" popup can appear no matter which mode
          the user is in. */}
      <UpdatePrompt />
    </AuthProvider>
  </StrictMode>
);

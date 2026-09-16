import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import "./mode/modeTabs.css";

type RuntimeFailure = { message: string; stack?: string };

function asRuntimeFailure(value: unknown): RuntimeFailure {
  if (value instanceof Error) return { message: value.message || value.name, stack: value.stack };
  if (typeof value === "string") return { message: value };
  try { return { message: JSON.stringify(value) }; } catch { return { message: "Unknown runtime error" }; }
}

// Capture failures that happen before React has mounted. Without this, a
// startup exception leaves #root empty and looks exactly like an endless load.
let pendingRuntimeFailure: RuntimeFailure | null = null;
const runtimeFailureEvent = "fontseru:runtime-failure";
if (typeof window !== "undefined") {
  const report = (value: unknown) => {
    if (pendingRuntimeFailure) return;
    pendingRuntimeFailure = asRuntimeFailure(value);
    window.dispatchEvent(new CustomEvent(runtimeFailureEvent));
  };
  window.addEventListener("error", (event) => report(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => report(event.reason));
}

function resetFontSeruLocalData() {
  try { localStorage.removeItem("fontseru.appMode"); localStorage.removeItem("mfs-theme"); } catch { /* ignore */ }
  try {
    const request = indexedDB.deleteDatabase("fontseru");
    request.onsuccess = request.onerror = request.onblocked = () => window.location.reload();
  } catch { window.location.reload(); }
}

interface RuntimeBoundaryProps { children: ReactNode }
interface RuntimeBoundaryState { failure: RuntimeFailure | null }

class RuntimeBoundary extends Component<RuntimeBoundaryProps, RuntimeBoundaryState> {
  state: RuntimeBoundaryState = { failure: pendingRuntimeFailure };

  componentDidMount() {
    window.addEventListener(runtimeFailureEvent, this.onRuntimeFailure);
  }

  componentWillUnmount() {
    window.removeEventListener(runtimeFailureEvent, this.onRuntimeFailure);
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ failure: { message: error.message || error.name, stack: error.stack ?? info.componentStack ?? undefined } });
  }

  onRuntimeFailure = () => {
    this.setState({ failure: pendingRuntimeFailure });
  };

  render() {
    if (!this.state.failure) return this.props.children;
    const { failure } = this.state;
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#101311", color: "#f3f5f4", fontFamily: "Inter, system-ui, sans-serif" }}>
        <section style={{ width: "min(680px, 100%)", padding: 28, border: "1px solid #3b443e", borderRadius: 14, background: "#171b18", boxShadow: "0 20px 60px #0008" }}>
          <h1 style={{ margin: "0 0 10px", fontSize: 22 }}>FontSeru gagal memuat</h1>
          <p style={{ margin: "0 0 18px", color: "#b9c2bc", lineHeight: 1.5 }}>Terjadi error saat membuka editor. Muat ulang halaman terlebih dahulu.</p>
          <pre style={{ maxHeight: 180, overflow: "auto", margin: "0 0 20px", padding: 12, borderRadius: 8, background: "#0c0f0d", color: "#ffb4ab", whiteSpace: "pre-wrap", fontSize: 12 }}>{failure.message}{failure.stack ? `\\n\\n${failure.stack}` : ""}</pre>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" onClick={() => window.location.reload()} style={{ padding: "9px 14px", border: 0, borderRadius: 8, background: "#b9f36b", color: "#14200e", fontWeight: 700, cursor: "pointer" }}>Muat ulang</button>
            <button type="button" onClick={resetFontSeruLocalData} style={{ padding: "9px 14px", border: "1px solid #526057", borderRadius: 8, background: "transparent", color: "#f3f5f4", cursor: "pointer" }}>Reset data lokal lalu muat ulang</button>
          </div>
        </section>
      </main>
    );
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  document.body.innerHTML = `<main style="min-height:100vh;display:grid;place-items:center;background:#101311;color:#f3f5f4;font:16px system-ui">FontSeru: root element tidak ditemukan.</main>`;
  throw new Error("Root element #root not found in index.html");
}

try {
  // Keep the heavyweight editor imports inside the guarded bootstrap. A bad
  // module evaluation now reaches the recovery UI instead of leaving a blank
  // document before React can mount.
  Promise.all([import("./App"), import("./auth/AuthProvider")]).then(([appModule, authModule]) => {
    const App = appModule.default;
    const AuthProvider = authModule.AuthProvider;
    createRoot(rootEl).render(
      <StrictMode>
        <RuntimeBoundary>
          <AuthProvider>
            <App />
          </AuthProvider>
        </RuntimeBoundary>
      </StrictMode>
    );
  }).catch((error) => {
    pendingRuntimeFailure = asRuntimeFailure(error);
    rootEl.innerHTML = `<main style="min-height:100vh;display:grid;place-items:center;padding:24px;background:#101311;color:#f3f5f4;font:16px system-ui"><section><h1>FontSeru gagal memuat</h1><pre style="white-space:pre-wrap;color:#ffb4ab">${String(pendingRuntimeFailure.stack || pendingRuntimeFailure.message).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c))}</pre><button onclick="location.reload()">Muat ulang</button></section></main>`;
  });
} catch (error) {
  rootEl.innerHTML = `<main style="min-height:100vh;display:grid;place-items:center;padding:24px;background:#101311;color:#f3f5f4;font:16px system-ui"><section><h1>FontSeru gagal memuat</h1><pre style="white-space:pre-wrap;color:#ffb4ab">${String(error instanceof Error ? error.stack || error.message : error).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c))}</pre><button onclick="location.reload()">Muat ulang</button></section></main>`;
}

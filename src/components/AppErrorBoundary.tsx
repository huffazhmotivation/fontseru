import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { isStaleChunkError, reloadForFreshBuild, shouldAttemptReload } from "@/utils/staleBuildRecovery";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  autoReloading: boolean;
}

/**
 * Wraps the whole app (see main.tsx). Before this existed, ANY uncaught
 * render error — most notably a failed dynamic import() of a lazy-loaded
 * chunk (Motion Studio, Test Lab, Feature Builder...) when a stale build is
 * still resident after a relaunch, see staleBuildRecovery.ts — unmounted
 * the entire React tree with nothing rendered in its place: a blank white
 * screen with no explanation and no way forward except the user figuring
 * out to manually refresh.
 *
 * Now: a crash that looks like the stale-build case triggers one guarded
 * automatic reload (the exact same recovery a manual refresh gives). Any
 * other crash — or a second stale-build crash too soon after the first —
 * shows a small, on-brand recovery card with a manual reload button instead
 * of a dead page.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, autoReloading: false };

  static getDerivedStateFromError(): State {
    return { hasError: true, autoReloading: false };
  }

  componentDidCatch(error: unknown, info: { componentStack: string }) {
    console.error("FontSeru crashed:", error, info.componentStack);
    if (isStaleChunkError(error) && shouldAttemptReload()) {
      this.setState({ autoReloading: true });
      reloadForFreshBuild();
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="fm-auth-backdrop fm-update-backdrop" role="alertdialog" aria-live="assertive">
        <div className="fm-auth-dialog fm-welcome-dialog fm-update-dialog">
          <div className="fm-update-icon-wrap" aria-hidden="true">
            {this.state.autoReloading && <span className="fm-update-icon-ring" />}
            <span className="fm-update-icon-core fm-update-icon-core-warn">
              {this.state.autoReloading ? (
                <RefreshCw size={20} strokeWidth={2.25} className="fm-update-icon-spin" />
              ) : (
                <AlertTriangle size={20} strokeWidth={2.25} />
              )}
            </span>
          </div>
          <p className="fm-update-title">
            {this.state.autoReloading ? "Memuat ulang..." : "Terjadi kendala saat memuat FontSeru"}
          </p>
          <div className="fm-update-content-box">
            <p className="fm-update-sub">
              {this.state.autoReloading
                ? "Sesi ini menyimpan versi lama. Halaman akan dimuat ulang otomatis."
                : "Coba muat ulang halaman untuk mengambil versi terbaru."}
            </p>
          </div>
          {!this.state.autoReloading && (
            <button
              type="button"
              className="fm-auth-submit-btn fm-auth-btn-pro"
              onClick={() => window.location.reload()}
              data-testid="app-crash-reload-btn"
            >
              <RefreshCw size={15} strokeWidth={2.25} aria-hidden="true" />
              Muat Ulang Halaman
            </button>
          )}
        </div>
      </div>
    );
  }
}

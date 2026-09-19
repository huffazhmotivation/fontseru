import { Sparkles, X } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { FontSeruLogo } from "@/components/FontSeruLogo";

/**
 * One-time popup shown right after a user clicks the "Confirm your signup"
 * link in their email and lands back in the app already logged in (see
 * `justConfirmedEmail` in AuthProvider). Stays on screen until the user
 * explicitly closes it (the "×" button) — no auto-dismiss timer, and the
 * backdrop is not clickable, so it can't be missed. It still never blocks
 * the editor the way `LoginModal` does — there's no keyboard lock behind
 * it.
 */
export function EmailConfirmedWelcome() {
  const { justConfirmedEmail, dismissEmailConfirmedWelcome } = useAuth();

  if (!justConfirmedEmail) return null;

  return (
    <div
      className="fm-auth-backdrop fm-welcome-backdrop"
      role="status"
      aria-live="polite"
      data-testid="email-confirmed-welcome"
    >
      <div className="fm-auth-dialog fm-welcome-dialog">
        <button
          type="button"
          className="fm-welcome-close"
          onClick={dismissEmailConfirmedWelcome}
          aria-label="Tutup"
          data-testid="email-confirmed-welcome-close"
        >
          <X size={16} />
        </button>
        <FontSeruLogo />
        <Sparkles className="fm-welcome-icon" size={22} strokeWidth={1.75} aria-hidden="true" />
        <p className="fm-welcome-greeting">Assalamualaikum, selamat datang di FontSeru!</p>
        <p className="fm-welcome-sub">Email Anda berhasil diverifikasi dan Anda berhasil login.</p>
        <button
          type="button"
          className="fm-auth-submit-btn fm-auth-btn-pro"
          onClick={dismissEmailConfirmedWelcome}
          data-testid="email-confirmed-welcome-dismiss"
        >
          Mulai Berkarya
        </button>
      </div>
    </div>
  );
}

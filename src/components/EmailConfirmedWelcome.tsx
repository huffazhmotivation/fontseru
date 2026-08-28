import { useEffect } from "react";
import { Sparkles } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { FontSeruLogo } from "@/components/FontSeruLogo";

/**
 * One-time popup shown right after a user clicks the "Confirm your signup"
 * link in their email and lands back in the app already logged in (see
 * `justConfirmedEmail` in AuthProvider). Auto-dismisses after a few
 * seconds, or immediately on click — it never blocks the editor the way
 * `LoginModal` does.
 */
export function EmailConfirmedWelcome() {
  const { justConfirmedEmail, dismissEmailConfirmedWelcome } = useAuth();

  useEffect(() => {
    if (!justConfirmedEmail) return;
    const timer = window.setTimeout(dismissEmailConfirmedWelcome, 4000);
    return () => window.clearTimeout(timer);
  }, [justConfirmedEmail, dismissEmailConfirmedWelcome]);

  if (!justConfirmedEmail) return null;

  return (
    <div
      className="fm-auth-backdrop fm-welcome-backdrop"
      role="status"
      aria-live="polite"
      data-testid="email-confirmed-welcome"
      onClick={dismissEmailConfirmedWelcome}
    >
      <div className="fm-auth-dialog fm-welcome-dialog" onClick={(event) => event.stopPropagation()}>
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

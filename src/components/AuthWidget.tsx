import { useEffect, useRef, useState } from "react";
import { Crown, LogIn, LogOut } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { useAppStore } from "@/glyph/store";

function initialsFromEmail(email: string | null | undefined): string {
  if (!email) return "?";
  return email.slice(0, 2).toUpperCase();
}

/**
 * Account UI shown in the top bar. Signed out: a persistent "Login" button
 * that opens the login popup (see LoginModal.tsx). Signed in: an account
 * menu showing the email and FREE/PRO plan status.
 */
export function AuthWidget() {
  const { initializing, user, plan, isPro, profileLoading, signOut } = useAuth();
  const openLoginModal = useAppStore((s) => s.openLoginModal);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Rendered with `position: fixed` at this JS-computed viewport position
  // (see the matching CSS comment on `.fm-auth-menu`) instead of
  // `position: absolute`, so it isn't clipped by the topbar's own
  // horizontal scroll container on tablet/phone widths.
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClickAway = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [menuOpen]);

  // Closes on scroll (captured on window since scroll events don't bubble
  // — this is what catches the topbar's own horizontal scroll) or resize,
  // instead of continuously repositioning a short-lived menu.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpen]);

  const openMenu = () => {
    const rect = menuRef.current?.getBoundingClientRect();
    const right = rect ? Math.max(10, window.innerWidth - rect.right) : 14;
    const top = rect ? rect.bottom + 8 : 60;
    setMenuPos({ top, right });
    setMenuOpen(true);
  };

  const handleSignOut = async () => {
    setMenuOpen(false);
    await signOut();
  };

  if (initializing) {
    return <div className="fm-auth-placeholder" aria-hidden="true" />;
  }

  if (user) {
    return (
      <div className="fm-auth-user" ref={menuRef}>
        <button
          type="button"
          className="fm-auth-avatar-btn"
          onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
          title={user.email ?? "Account"}
          data-testid="auth-account-btn"
        >
          <span className="fm-auth-avatar">{initialsFromEmail(user.email)}</span>
          <span className={`fm-auth-plan-badge fm-auth-plan-${plan}`}>
            {isPro && <Crown size={11} />}
            {profileLoading ? "…" : isPro ? "Pro" : "Free"}
          </span>
        </button>
        {menuOpen && (
          <div
            className="fm-auth-menu"
            role="menu"
            data-testid="auth-menu"
            style={menuPos ? { top: menuPos.top, right: menuPos.right } : undefined}
          >
            <div className="fm-auth-menu-email">{user.email}</div>
            <div className="fm-auth-menu-plan">
              Plan: <strong>{isPro ? "Pro" : "Free"}</strong>
            </div>
            <button type="button" className="fm-auth-menu-item" onClick={handleSignOut} data-testid="auth-signout-btn">
              <LogOut size={14} /> Sign out
            </button>
          </div>
        )}
      </div>
    );
  }

  // Signed out: always show a Login entry point in the top bar, so account
  // access never depends solely on the auto-gate having appeared/still
  // being open.
  return (
    <button
      type="button"
      className="fm-topbtn fm-auth-login-btn"
      onClick={() => openLoginModal()}
      data-testid="auth-login-btn"
    >
      <LogIn size={15} /> Login
    </button>
  );
}

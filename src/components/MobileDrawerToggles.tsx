import { Menu, PanelRight } from "lucide-react";
import { useAppStore } from "@/glyph/store";

/**
 * Floating shortcuts for the glyph-list (left) and inspector (right) drawer
 * panels, shown on iPad/phone widths (≤900px, see app.css) where those
 * panels collapse into off-canvas drawers instead of staying permanently
 * docked.
 *
 * These used to live inline inside TopBar, right next to each other at the
 * very start of the bar — which put the *right*-panel shortcut on the
 * *left* edge of the screen, crowded the identity row (logo/file name), and
 * was a big part of why the bar looked cramped/uneven on phone widths.
 * Floating them here instead, each docked to the actual edge/side it opens
 * from, keeps the top bar to just identity + actions and makes each
 * shortcut sit where it visually belongs.
 *
 * Rendered as a sibling of the canvas inside `.fm-canvas-area` (already a
 * `position: relative` anchor — same pattern as FloatingToolbar/
 * GlyphSideNav), so it floats over the editor rather than the page. Not
 * rendered in Sketch Mode: the glyph list always stays folded there and the
 * right panel already has its own dedicated floating toggle
 * (SketchRightPanelToggle), so these would just be inert duplicates.
 */
export function MobileDrawerToggles() {
  const toggleMobileNav = useAppStore((s) => s.toggleMobileNav);
  const toggleMobilePanel = useAppStore((s) => s.toggleMobilePanel);

  return (
    <>
      <button
        type="button"
        className="fm-mobile-nav-toggle"
        onClick={toggleMobileNav}
        title="Glyph list"
        aria-label="Toggle glyph list"
        data-testid="mobile-nav-toggle"
      >
        <Menu size={18} />
      </button>
      <button
        type="button"
        className="fm-mobile-panel-toggle"
        onClick={toggleMobilePanel}
        title="Inspector panel"
        aria-label="Toggle inspector panel"
        data-testid="mobile-panel-toggle"
      >
        <PanelRight size={18} />
      </button>
    </>
  );
}

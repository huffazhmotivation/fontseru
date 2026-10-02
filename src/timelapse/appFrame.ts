/**
 * Frame capture for the "Whole app" timelapse source: the entire editor —
 * canvas, side panels, toolbars, open menus — photographed from the page
 * itself with html2canvas-pro (the maintained fork that understands modern CSS colors like color-mix, which the original chokes on), so it needs NO screen-share permission and
 * therefore works on iPad/iPhone/Android where `getDisplayMedia` doesn't
 * exist.
 *
 * A DOM photo is slow (hundreds of ms on a busy screen), so a frame is only
 * taken when the page actually changed: a MutationObserver marks the page
 * "dirty" on any DOM change (a new stroke, a moved panel, a menu opening),
 * and pointer/scroll input marks it too (the brush preview and hover states
 * change without DOM writes we can observe cheaply).
 */

/** SVG properties that resolve CSS variables / stylesheet rules. html2canvas
 * redraws an <svg> as a standalone image, which no longer sees the page's
 * stylesheet or `--ink`-style variables — so the resolved values from the
 * live document are written onto the clone as inline style first. */
const SVG_PROPS = [
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray",
  "stroke-linecap", "stroke-linejoin", "opacity", "font-size", "font-family", "font-weight", "display", "visibility",
] as const;
const MAX_SVG_ELEMENTS = 6000;

function inlineSvgStyles(original: Element, clone: Element): void {
  const src = original.querySelectorAll("*");
  const dst = clone.querySelectorAll("*");
  if (src.length !== dst.length || src.length > MAX_SVG_ELEMENTS) return;
  for (let i = 0; i < src.length; i++) {
    const cs = getComputedStyle(src[i]);
    const style = (dst[i] as SVGElement).style;
    if (!style) continue;
    for (const prop of SVG_PROPS) style.setProperty(prop, cs.getPropertyValue(prop));
  }
}

export class AppFrameCapturer {
  private dirty = true;
  private observer: MutationObserver | null = null;
  private readonly root: HTMLElement;
  private readonly onInput = () => {
    this.dirty = true;
  };

  constructor() {
    this.root = (document.querySelector(".fm-root") as HTMLElement | null) ?? document.body;
    this.observer = new MutationObserver((records) => {
      // The REC badge clock and the Timelapse panel change constantly but
      // aren't part of the video, so they must not count as "changed".
      for (const r of records) {
        const el = r.target instanceof Element ? r.target : r.target.parentElement;
        if (!el?.closest(".fm-timelapse-badge, .fm-lab-backdrop")) {
          this.dirty = true;
          return;
        }
      }
    });
    this.observer.observe(this.root, { subtree: true, childList: true, attributes: true, characterData: true });
    window.addEventListener("pointermove", this.onInput, { passive: true });
    window.addEventListener("resize", this.onInput);
  }

  /** Viewport size to base the video's aspect ratio on. */
  static viewportSize(): { width: number; height: number } {
    return { width: Math.max(2, window.innerWidth), height: Math.max(2, window.innerHeight) };
  }

  /** True if anything might have changed since the last frame. */
  isDirty(): boolean {
    return this.dirty;
  }

  /** Takes one photo of the page and draws it onto `ctx` (already sized to
   * the video's frame). */
  async draw(ctx: CanvasRenderingContext2D, width: number, height: number): Promise<void> {
    this.dirty = false;
    const html2canvas = (await import("html2canvas-pro")).default;
    const rect = this.root.getBoundingClientRect();
    const scale = Math.max(0.4, Math.min(2, width / Math.max(1, rect.width)));
    const shot = await html2canvas(this.root, {
      scale,
      logging: false,
      useCORS: true,
      backgroundColor: getComputedStyle(this.root).backgroundColor || "#171717",
      width: rect.width,
      height: rect.height,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      // Keep the recording UI itself (the Timelapse panel, the REC badge) out
      // of the video.
      ignoreElements: (el) =>
        el instanceof HTMLElement && (el.classList.contains("fm-lab-backdrop") || el.classList.contains("fm-timelapse-badge")),
      onclone: (doc, clonedRoot) => {
        const liveSvgs = this.root.querySelectorAll("svg");
        const clonedSvgs = clonedRoot.querySelectorAll("svg");
        if (liveSvgs.length !== clonedSvgs.length) return;
        liveSvgs.forEach((svg, i) => inlineSvgStyles(svg, clonedSvgs[i]));
      },
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#171717";
    ctx.fillRect(0, 0, width, height);
    // Fit without distortion (the window may have been resized mid-recording).
    const k = Math.min(width / shot.width, height / shot.height);
    const w = shot.width * k;
    const h = shot.height * k;
    ctx.drawImage(shot, (width - w) / 2, (height - h) / 2, w, h);
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener("pointermove", this.onInput);
    window.removeEventListener("resize", this.onInput);
  }
}

import type { ComponentType } from "react";

/**
 * Type shim for the Motion Font Studio engine, which ships as a single
 * self-contained `.jsx` module (`MotionStudio.jsx`). It has no props — it
 * owns all of its own state internally. This declaration lets the
 * TypeScript side (App.tsx) import it via `@/motion/MotionStudio` without
 * enabling `allowJs` (which would try to type-check the whole engine).
 * Vite/esbuild resolves the real `.jsx` at build time.
 */
declare const MotionStudio: ComponentType;
export default MotionStudio;

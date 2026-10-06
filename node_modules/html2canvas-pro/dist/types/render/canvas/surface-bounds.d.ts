import { Bounds } from '../../css/layout/bounds';
import { ElementContainer } from '../../dom/element-container';
export declare const MAX_SURFACE_PIXELS: number;
export declare const MAX_SURFACE_SIDE = 8192;
export interface SurfaceBudget {
    pixels: number;
}
export declare function reserveSurface(budget: SurfaceBudget, width: number, height: number): number;
export declare function surfaceBounds(container: ElementContainer): Bounds;
export declare function cropSurface(bounds: Bounds, viewport: Bounds, margin: number, scale: number): Bounds;

import { BoxShadow } from '../../css/property-descriptors/box-shadow';
import { ElementPaint } from '../stacking-context';
import { SurfaceBudget } from './surface-bounds';
interface ShadowOptions {
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
    signal?: AbortSignal;
}
export declare const paintBoxShadow: (ctx: CanvasRenderingContext2D, paint: ElementPaint, shadow: BoxShadow[number], options: ShadowOptions, budget: SurfaceBudget) => Promise<void>;
export {};

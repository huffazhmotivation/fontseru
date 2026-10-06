import { Bounds } from '../../css/layout/bounds';
export interface ShadowTransform {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}
export interface ShadowSpace {
    matrix: ShadowTransform;
    viewport: Bounds;
    scale: number;
    uniform: boolean;
}
export declare const shadowSpace: (matrix: ShadowTransform, width: number, height: number) => ShadowSpace | null;

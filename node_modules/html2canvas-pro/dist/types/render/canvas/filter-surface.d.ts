export declare class FilterSurfaceError extends Error {
}
export declare const releaseSurface: (canvas: HTMLCanvasElement) => void;
export interface SimpleFilter {
    blur: number;
    shadow?: {
        x: number;
        y: number;
        blur: number;
        color: string;
    };
}
export declare function parseSimpleFilter(value: string | null): SimpleFilter | null;
export declare function filterOutset(filter: SimpleFilter): number;
export declare function supportsNativeFilters(owner?: Document): boolean;
export declare function renderFilterSurface(source: HTMLCanvasElement, filter: SimpleFilter, opacity: number, scale: number, signal?: AbortSignal): Promise<HTMLCanvasElement>;
export declare function renderSvgFilterSurface(source: HTMLCanvasElement, { blur, shadow }: SimpleFilter, opacity: number, scale: number, signal?: AbortSignal): Promise<HTMLCanvasElement>;

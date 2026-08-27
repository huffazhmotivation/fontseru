// Thin wrapper around the "polygon-clipping" package.
//
// Its published .d.ts declares named exports (union/intersection/xor/
// difference), but the actual ESM build it ships only has a default export
// (an object holding those functions) — no real named exports at runtime.
// Importing the named exports directly works under Node's CJS interop (and
// so passes a naive Node/tsc check) but breaks under Vite/Rollup's real ESM
// resolution, which was causing the app to fail to load entirely (blank
// screen) in dev and to fail outright in a production build.
//
// Importing the whole namespace and reading `.default` off it works
// correctly under real ESM, while the fallback below also covers bundlers/
// runtimes that do synthesize the named exports directly onto the module.
import * as polygonClippingModule from "polygon-clipping";

export type Pair = [number, number];
export type Ring = Pair[];
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];
type Geom = Polygon | MultiPolygon;

interface PolygonClippingApi {
  union: (geom: Geom, ...geoms: Geom[]) => MultiPolygon;
  intersection: (geom: Geom, ...geoms: Geom[]) => MultiPolygon;
  xor: (geom: Geom, ...geoms: Geom[]) => MultiPolygon;
  difference: (subjectGeom: Geom, ...clipGeoms: Geom[]) => MultiPolygon;
}

const namespace = polygonClippingModule as unknown as { default?: PolygonClippingApi } & Partial<PolygonClippingApi>;
const api: PolygonClippingApi =
  namespace.default ??
  ({
    union: namespace.union!,
    intersection: namespace.intersection!,
    xor: namespace.xor!,
    difference: namespace.difference!,
  } as PolygonClippingApi);

export const union = api.union;
export const intersection = api.intersection;
export const xor = api.xor;
export const difference = api.difference;

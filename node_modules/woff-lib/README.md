# woff-lib

[![npm version](https://img.shields.io/npm/v/woff-lib.svg)](https://www.npmjs.com/package/woff-lib)

TypeScript WOFF and WOFF2 encoder and decoder. Relies on [brotli-lib](https://github.com/countertype/brotli-lib)

## Install

```bash
npm install woff-lib
```

## Usage

```typescript
// WOFF2 decode
import { woff2Decode } from 'woff-lib/woff2/decode'
const ttf = await woff2Decode(woff2Data)

// WOFF2 encode
import { woff2Encode } from 'woff-lib/woff2/encode'
const woff2 = woff2Encode(ttfData, { quality: 11 })

// WOFF decode
import { woffDecode } from 'woff-lib/woff/decode'
const ttf = await woffDecode(woffData)

// WOFF encode
import { woffEncode } from 'woff-lib/woff/encode'
const woff = await woffEncode(ttfData)

// Import everything
import { woffDecode, woffEncode, woff2Decode, woff2Encode } from 'woff-lib'
```

## API

### woff2Decode

```typescript
function woff2Decode(data: ArrayBuffer | Uint8Array): Promise<Uint8Array>
```

Decodes WOFF2 to TTF/OTF. Async to use native Brotli (Node zlib, browser DecompressionStream) when available (falls back to pure JS in Chrome)

### woff2Encode

```typescript
function woff2Encode(
  data: ArrayBuffer | Uint8Array,
  options?: { quality?: number }  // 0-11, default 11
): Uint8Array
```

Encodes TTF/OTF to WOFF2. Implements glyf/loca and hmtx transforms per spec

### woffDecode

```typescript
function woffDecode(data: ArrayBuffer | Uint8Array): Promise<Uint8Array>
```

Decodes WOFF to TTF/OTF. Uses native zlib (Node) or DecompressionStream (browser)

### woffEncode

```typescript
function woffEncode(
  data: ArrayBuffer | Uint8Array,
  options?: { level?: number }  // 1-9, default 9
): Promise<Uint8Array>
```

Encodes TTF/OTF to WOFF. Async to use native zlib (Node) or CompressionStream (browser)

## Tree-shaking

| Import | Bundle size |
|--------|-------------|
| `woff-lib/woff/decode` | ~4 KB |
| `woff-lib/woff/encode` | ~4 KB |
| `woff-lib/woff2/decode` | ~33 KB |
| `woff-lib/woff2/encode` | ~24 KB |
| `woff-lib/decode` | ~37 KB |
| `woff-lib/encode` | ~24 KB |
| `woff-lib` | ~60 KB |

WOFF2 decoder includes brotli-lib fallback, which is ~80 KB

## Performance

| Operation | TTF (305 KB) | CFF/OTF (253 KB) | Variable TTF (788 KB) |
|-----------|--------------|-------------------|----------------------|
| woff2Encode (q11) | 781 ms | 860 ms | 1,918 ms |
| woff2Encode (q4) | 7.4 ms | 5.4 ms | 18.3 ms |
| woff2Decode | 2.4 ms | 1.6 ms | 5.1 ms |
| woff2Decode (pure JS) | 3.3 ms | 2.6 ms | 7.5 ms |
| woffEncode | 11.3 ms | 8.4 ms | 23.7 ms |
| woffDecode | 0.8 ms | 0.7 ms | 2.2 ms |

Tested on Apple M2 Max, Node.js 22. woff2Decode uses native Brotli via `node:zlib` when available, falling back to pure JS ([brotli-lib](https://github.com/countertype/brotli-lib)) in browsers without native Brotli decompression (e.g. Chrome). WOFF uses native zlib

## Platform support

- **Node.js** 16+ (uses native zlib)
- **Browsers**: Chrome 80+, Firefox 113+, Safari 16.4+ (DecompressionStream)

## License

MIT

Derived from Google's [woff2](https://github.com/google/woff2) (see LICENSE_THIRD_PARTY)

Maintained by [@jpt](https://github.com/jpt)

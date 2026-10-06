import { brotliDecode } from "brotli-lib/decode";

//#region \0rolldown/runtime.js
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, { get: (a, b) => (typeof require !== "undefined" ? require : a)[b] }) : x)(function(x) {
	if (typeof require !== "undefined") return require.apply(this, arguments);
	throw Error("Calling `require` for \"" + x + "\" in an environment that doesn't expose the `require` function. See https://rolldown.rs/in-depth/bundling-cjs#require-external-modules for more details.");
});

//#endregion
//#region src/woff2/decode/brotli.ts
let nativeBrotli = null;
let browserBrotli = null;
function tryLoadNative() {
	try {
		if (typeof process !== "undefined" && process.versions?.node) {
			const zlib = __require("node:zlib");
			if (typeof zlib.brotliDecompressSync === "function") return (buf) => {
				const result = zlib.brotliDecompressSync(buf);
				return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
			};
		}
	} catch {}
	return null;
}
function tryLoadBrowserBrotli() {
	try {
		if (typeof DecompressionStream !== "undefined") {
			new DecompressionStream("brotli");
			return async (buf) => {
				const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
				const decompressed = new Blob([arrayBuf]).stream().pipeThrough(new DecompressionStream("brotli"));
				return new Uint8Array(await new Response(decompressed).arrayBuffer());
			};
		}
	} catch {}
	return null;
}
nativeBrotli = tryLoadNative();
browserBrotli = tryLoadBrowserBrotli();
async function decompress(data) {
	if (nativeBrotli) return nativeBrotli(data);
	if (browserBrotli) return browserBrotli(data);
	return brotliDecode(data);
}

//#endregion
//#region src/woff2/decode/buffer.ts
var Buffer$1 = class {
	constructor(data, offset = 0, length) {
		this.pos = 0;
		if (data instanceof Uint8Array) {
			const len = length ?? data.byteLength - offset;
			this.u8 = data.subarray(offset, offset + len);
		} else {
			const len = length ?? data.byteLength - offset;
			this.u8 = new Uint8Array(data, offset, len);
		}
	}
	get offset() {
		return this.pos;
	}
	get length() {
		return this.u8.byteLength;
	}
	get remaining() {
		return this.u8.byteLength - this.pos;
	}
	skip(n) {
		if (this.pos + n > this.u8.byteLength || this.pos + n < this.pos) return false;
		this.pos += n;
		return true;
	}
	seek(offset) {
		if (offset > this.u8.byteLength || offset < 0) return false;
		this.pos = offset;
		return true;
	}
	readU8() {
		if (this.pos + 1 > this.u8.byteLength) return null;
		return this.u8[this.pos++];
	}
	readU16() {
		if (this.pos + 2 > this.u8.byteLength) return null;
		const idx = this.pos;
		this.pos = idx + 2;
		return this.u8[idx] << 8 | this.u8[idx + 1];
	}
	readS16() {
		if (this.pos + 2 > this.u8.byteLength) return null;
		const idx = this.pos;
		this.pos = idx + 2;
		const val = this.u8[idx] << 8 | this.u8[idx + 1];
		return (val & 32768) !== 0 ? val - 65536 : val;
	}
	readU32() {
		if (this.pos + 4 > this.u8.byteLength) return null;
		const idx = this.pos;
		this.pos = idx + 4;
		return this.u8[idx] * 16777216 + (this.u8[idx + 1] << 16 | this.u8[idx + 2] << 8 | this.u8[idx + 3]) >>> 0;
	}
	readBytes(n) {
		if (this.pos + n > this.u8.byteLength || n < 0) return null;
		const result = this.u8.subarray(this.pos, this.pos + n);
		this.pos += n;
		return result;
	}
	subarray(offset, length) {
		if (offset + length > this.u8.byteLength || offset < 0 || length < 0) return null;
		return this.u8.subarray(offset, offset + length);
	}
};

//#endregion
//#region src/shared/known-tags.ts
const KNOWN_TAGS = [
	1668112752,
	1751474532,
	1751672161,
	1752003704,
	1835104368,
	1851878757,
	1330851634,
	1886352244,
	1668707360,
	1718642541,
	1735162214,
	1819239265,
	1886545264,
	1128678944,
	1448038983,
	1161970772,
	1161972803,
	1734439792,
	1751412088,
	1801810542,
	1280594760,
	1346587732,
	1447316824,
	1986553185,
	1986884728,
	1111577413,
	1195656518,
	1196445523,
	1196643650,
	1161974595,
	1246975046,
	1296127048,
	1128416340,
	1128418371,
	1129270354,
	1129333068,
	1398163232,
	1935829368,
	1633906292,
	1635148146,
	1650745716,
	1651273571,
	1651731566,
	1668702578,
	1717859171,
	1717920116,
	1718449272,
	1719034226,
	1735811442,
	1752396921,
	1786082164,
	1818452338,
	1836020340,
	1836020344,
	1869636196,
	1886547824,
	1953653099,
	1516335206,
	1399417958,
	1198285172,
	1198288739,
	1181049204,
	1399417964
];
const TAG_GLYF = 1735162214;
const TAG_LOCA = 1819239265;
const TAG_HMTX = 1752003704;
const TAG_HHEA = 1751672161;
const TAG_HEAD = 1751474532;
const TTC_FLAVOR = 1953784678;
const WOFF2_SIGNATURE = 2001684018;
const WOFF2_FLAGS_TRANSFORM = 32;
function tagToString(tag) {
	return String.fromCharCode(tag >> 24 & 255, tag >> 16 & 255, tag >> 8 & 255, tag & 255);
}

//#endregion
//#region src/shared/variable-length.ts
function read255UShort(buf) {
	const code = buf.readU8();
	if (code === null) return null;
	if (code === 253) return buf.readU16();
	else if (code === 255) {
		const next = buf.readU8();
		if (next === null) return null;
		return 253 + next;
	} else if (code === 254) {
		const next = buf.readU8();
		if (next === null) return null;
		return 506 + next;
	}
	return code;
}
function readBase128(buf) {
	let result = 0;
	for (let i = 0; i < 5; i++) {
		const code = buf.readU8();
		if (code === null) return null;
		if (i === 0 && code === 128) return null;
		if ((result & 4261412864) !== 0) return null;
		result = result << 7 | code & 127;
		if ((code & 128) === 0) return result;
	}
	return null;
}

//#endregion
//#region src/shared/checksum.ts
function computeChecksum(data, offset, length) {
	let sum = 0;
	const end = offset + length;
	const view = new DataView(data.buffer, data.byteOffset);
	const alignedEnd = offset + (length & -4);
	for (let i = offset; i < alignedEnd; i += 4) sum = sum + view.getUint32(i) >>> 0;
	if (end > alignedEnd) {
		let last = 0;
		for (let i = alignedEnd; i < end; i++) last = last << 8 | data[i];
		last <<= (4 - (end - alignedEnd)) * 8;
		sum = sum + last >>> 0;
	}
	return sum;
}
function pad4(n) {
	return n + 3 & -4;
}

//#endregion
//#region src/woff2/decode/decode.ts
const SFNT_HEADER_SIZE = 12;
const SFNT_ENTRY_SIZE = 16;
const FLAG_ON_CURVE = 1;
const FLAG_X_SHORT = 2;
const FLAG_Y_SHORT = 4;
const FLAG_REPEAT = 8;
const FLAG_X_SAME = 16;
const FLAG_Y_SAME = 32;
const FLAG_OVERLAP_SIMPLE = 64;
async function woff2Decode(data) {
	const input = data instanceof Uint8Array ? data : new Uint8Array(data);
	const header = readHeader(new Buffer$1(input), input.byteLength);
	if (!header) throw new Error("Failed to read WOFF2 header");
	const decompressed = await decompress(input.subarray(header.compressedOffset, header.compressedOffset + header.compressedLength));
	if (!decompressed || decompressed.byteLength !== header.uncompressedSize) throw new Error(`Brotli decompression failed: expected ${header.uncompressedSize} bytes, got ${decompressed?.byteLength ?? 0}`);
	let outputSize = computeOffsetToFirstTable(header);
	for (const table of header.tables) {
		outputSize += table.origLength;
		outputSize += (4 - table.origLength % 4) % 4;
	}
	const output = new Uint8Array(outputSize);
	const outView = new DataView(output.buffer);
	const fontInfos = writeHeaders(header, output, outView);
	const writtenTables = /* @__PURE__ */ new Map();
	let nextTableOffset = computeOffsetToFirstTable(header);
	if (header.ttcFonts.length > 0) for (let i = 0; i < header.ttcFonts.length; i++) nextTableOffset = reconstructFont(decompressed, header, i, fontInfos[i], output, outView, writtenTables, nextTableOffset);
	else reconstructFont(decompressed, header, 0, fontInfos[0], output, outView, writtenTables, nextTableOffset);
	return output;
}
function readHeader(buf, totalLength) {
	if (buf.readU32() !== WOFF2_SIGNATURE) return null;
	const flavor = buf.readU32();
	if (flavor === null) return null;
	const length = buf.readU32();
	if (length === null || length !== totalLength) return null;
	const numTables = buf.readU16();
	if (numTables === null || numTables === 0) return null;
	if (!buf.skip(2)) return null;
	if (!buf.skip(4)) return null;
	const compressedLength = buf.readU32();
	if (compressedLength === null) return null;
	if (!buf.skip(4)) return null;
	const metaOffset = buf.readU32();
	const metaLength = buf.readU32();
	const metaOrigLength = buf.readU32();
	if (metaOffset === null || metaLength === null || metaOrigLength === null) return null;
	if (metaOffset !== 0) {
		if (metaOffset >= totalLength || totalLength - metaOffset < metaLength) return null;
	}
	const privOffset = buf.readU32();
	const privLength = buf.readU32();
	if (privOffset === null || privLength === null) return null;
	if (privOffset !== 0) {
		if (privOffset >= totalLength || totalLength - privOffset < privLength) return null;
	}
	const tables = readTableDirectory(buf, numTables);
	if (!tables) return null;
	const lastTable = tables[tables.length - 1];
	const uncompressedSize = lastTable.srcOffset + lastTable.srcLength;
	let headerVersion = 0;
	const ttcFonts = [];
	if (flavor === TTC_FLAVOR) {
		headerVersion = buf.readU32() ?? 0;
		if (headerVersion !== 65536 && headerVersion !== 131072) return null;
		const numFonts = read255UShort(buf);
		if (numFonts === null || numFonts === 0) return null;
		for (let i = 0; i < numFonts; i++) {
			const fontNumTables = read255UShort(buf);
			if (fontNumTables === null || fontNumTables === 0) return null;
			const fontFlavor = buf.readU32();
			if (fontFlavor === null) return null;
			const tableIndices = [];
			for (let j = 0; j < fontNumTables; j++) {
				const idx = read255UShort(buf);
				if (idx === null || idx >= tables.length) return null;
				tableIndices.push(idx);
			}
			ttcFonts.push({
				flavor: fontFlavor,
				dstOffset: 0,
				headerChecksum: 0,
				tableIndices
			});
		}
	}
	return {
		flavor,
		headerVersion,
		numTables,
		compressedOffset: buf.offset,
		compressedLength,
		uncompressedSize,
		tables,
		ttcFonts
	};
}
function readTableDirectory(buf, numTables) {
	const tables = [];
	let srcOffset = 0;
	for (let i = 0; i < numTables; i++) {
		const flagByte = buf.readU8();
		if (flagByte === null) return null;
		let tag;
		if ((flagByte & 63) === 63) {
			tag = buf.readU32() ?? 0;
			if (tag === 0) return null;
		} else tag = KNOWN_TAGS[flagByte & 63];
		const xformVersion = flagByte >> 6 & 3;
		let flags = 0;
		if (tag === TAG_GLYF || tag === TAG_LOCA) {
			if (xformVersion === 0) flags |= WOFF2_FLAGS_TRANSFORM;
		} else if (xformVersion !== 0) flags |= WOFF2_FLAGS_TRANSFORM;
		flags |= xformVersion;
		const origLength = readBase128(buf);
		if (origLength === null) return null;
		let transformLength = origLength;
		if ((flags & WOFF2_FLAGS_TRANSFORM) !== 0) {
			transformLength = readBase128(buf) ?? 0;
			if (transformLength === 0 && tag !== TAG_LOCA) return null;
			if (tag === TAG_LOCA && transformLength !== 0) return null;
		}
		tables.push({
			tag,
			flags,
			origLength,
			transformLength,
			srcOffset,
			srcLength: transformLength,
			dstOffset: 0,
			dstLength: origLength,
			key: `${tag}:${srcOffset}`
		});
		srcOffset += transformLength;
	}
	return tables;
}
function computeOffsetToFirstTable(header) {
	if (header.ttcFonts.length === 0) return SFNT_HEADER_SIZE + SFNT_ENTRY_SIZE * header.numTables;
	let offset = 12;
	offset += 4 * header.ttcFonts.length;
	if (header.headerVersion === 131072) offset += 12;
	for (const ttcFont of header.ttcFonts) {
		offset += SFNT_HEADER_SIZE;
		offset += SFNT_ENTRY_SIZE * ttcFont.tableIndices.length;
	}
	return offset;
}
function writeHeaders(header, output, outView) {
	const fontInfos = [];
	let offset = 0;
	if (header.ttcFonts.length > 0) {
		outView.setUint32(offset, header.flavor);
		offset += 4;
		outView.setUint32(offset, header.headerVersion);
		offset += 4;
		outView.setUint32(offset, header.ttcFonts.length);
		offset += 4;
		const offsetTableStart = offset;
		offset += 4 * header.ttcFonts.length;
		if (header.headerVersion === 131072) offset += 12;
		for (let i = 0; i < header.ttcFonts.length; i++) {
			const ttcFont = header.ttcFonts[i];
			outView.setUint32(offsetTableStart + i * 4, offset);
			ttcFont.dstOffset = offset;
			const numTables = ttcFont.tableIndices.length;
			offset = writeOffsetTable(outView, offset, ttcFont.flavor, numTables);
			const sortedIndices = [...ttcFont.tableIndices].sort((a, b) => header.tables[a].tag - header.tables[b].tag);
			const tableEntryByTag = /* @__PURE__ */ new Map();
			for (const tableIdx of sortedIndices) {
				const table = header.tables[tableIdx];
				tableEntryByTag.set(table.tag, offset);
				offset = writeTableEntry(outView, offset, table.tag);
			}
			ttcFont.tableIndices = sortedIndices;
			ttcFont.headerChecksum = computeChecksum(output, ttcFont.dstOffset, offset - ttcFont.dstOffset);
			fontInfos.push({
				numGlyphs: 0,
				indexFormat: 0,
				numHMetrics: 0,
				xMins: new Int16Array(0),
				tableEntryByTag
			});
		}
	} else {
		offset = writeOffsetTable(outView, offset, header.flavor, header.numTables);
		const sortedTables = [...header.tables].sort((a, b) => a.tag - b.tag);
		const tableEntryByTag = /* @__PURE__ */ new Map();
		for (const table of sortedTables) {
			tableEntryByTag.set(table.tag, offset);
			offset = writeTableEntry(outView, offset, table.tag);
		}
		fontInfos.push({
			numGlyphs: 0,
			indexFormat: 0,
			numHMetrics: 0,
			xMins: new Int16Array(0),
			tableEntryByTag
		});
	}
	return fontInfos;
}
function writeOffsetTable(view, offset, flavor, numTables) {
	view.setUint32(offset, flavor);
	view.setUint16(offset + 4, numTables);
	let maxPow2 = 0;
	while (1 << maxPow2 + 1 <= numTables) maxPow2++;
	const searchRange = (1 << maxPow2) * 16;
	view.setUint16(offset + 6, searchRange);
	view.setUint16(offset + 8, maxPow2);
	view.setUint16(offset + 10, numTables * 16 - searchRange);
	return offset + SFNT_HEADER_SIZE;
}
function writeTableEntry(view, offset, tag) {
	view.setUint32(offset, tag);
	view.setUint32(offset + 4, 0);
	view.setUint32(offset + 8, 0);
	view.setUint32(offset + 12, 0);
	return offset + SFNT_ENTRY_SIZE;
}
function reconstructFont(decompressed, header, fontIndex, fontInfo, output, outView, writtenTables, dstOffset) {
	const sortedTables = [...header.ttcFonts.length > 0 ? header.ttcFonts[fontIndex].tableIndices.map((i) => header.tables[i]) : header.tables].sort((a, b) => a.tag - b.tag);
	const glyfTable = sortedTables.find((t) => t.tag === TAG_GLYF);
	const locaTable = sortedTables.find((t) => t.tag === TAG_LOCA);
	const hheaTable = sortedTables.find((t) => t.tag === TAG_HHEA);
	if (hheaTable) {
		const hheaData = decompressed.subarray(hheaTable.srcOffset, hheaTable.srcOffset + hheaTable.srcLength);
		if (hheaData.byteLength >= 36) fontInfo.numHMetrics = new DataView(hheaData.buffer, hheaData.byteOffset).getUint16(34);
	}
	let fontChecksum = header.ttcFonts.length > 0 ? header.ttcFonts[fontIndex].headerChecksum : 0;
	const isTTC = header.ttcFonts.length > 0;
	for (const table of sortedTables) {
		const entryOffset = fontInfo.tableEntryByTag.get(table.tag);
		if (entryOffset === void 0) continue;
		const tKey = table.key;
		const existing = writtenTables.get(tKey);
		if (existing) {
			updateTableEntry(outView, entryOffset, existing.checksum, existing.dstOffset, existing.dstLength);
			if (isTTC) {
				fontChecksum = fontChecksum + existing.checksum >>> 0;
				fontChecksum = fontChecksum + computeTableEntryChecksum(existing.checksum, existing.dstOffset, existing.dstLength) >>> 0;
			}
			continue;
		}
		table.dstOffset = dstOffset;
		let tableData;
		let checksum;
		if ((table.flags & WOFF2_FLAGS_TRANSFORM) !== 0) if (table.tag === TAG_GLYF && glyfTable && locaTable) {
			const result = reconstructGlyf(decompressed, glyfTable, locaTable, fontInfo);
			tableData = result.glyfData;
			glyfTable.dstLength = result.glyfData.byteLength;
			locaTable.dstOffset = dstOffset + pad4(result.glyfData.byteLength);
			locaTable.dstLength = result.locaData.byteLength;
			output.set(tableData, dstOffset);
			checksum = computeChecksum(output, dstOffset, tableData.byteLength);
			updateTableEntry(outView, entryOffset, checksum, dstOffset, tableData.byteLength);
			if (isTTC) {
				fontChecksum = fontChecksum + checksum >>> 0;
				fontChecksum = fontChecksum + computeTableEntryChecksum(checksum, dstOffset, tableData.byteLength) >>> 0;
			}
			writtenTables.set(tKey, {
				dstOffset,
				dstLength: tableData.byteLength,
				checksum
			});
			dstOffset += pad4(tableData.byteLength);
			const locaEntryOffset = fontInfo.tableEntryByTag.get(TAG_LOCA);
			if (locaEntryOffset !== void 0) {
				output.set(result.locaData, dstOffset);
				const locaChecksum = computeChecksum(output, dstOffset, result.locaData.byteLength);
				updateTableEntry(outView, locaEntryOffset, locaChecksum, dstOffset, result.locaData.byteLength);
				if (isTTC) {
					fontChecksum = fontChecksum + locaChecksum >>> 0;
					fontChecksum = fontChecksum + computeTableEntryChecksum(locaChecksum, dstOffset, result.locaData.byteLength) >>> 0;
				}
				writtenTables.set(locaTable.key, {
					dstOffset,
					dstLength: result.locaData.byteLength,
					checksum: locaChecksum
				});
				dstOffset += pad4(result.locaData.byteLength);
			}
			continue;
		} else if (table.tag === TAG_LOCA) continue;
		else if (table.tag === TAG_HMTX) tableData = reconstructHmtx(decompressed, table, fontInfo.numGlyphs, fontInfo.numHMetrics, fontInfo.xMins);
		else throw new Error(`Unknown transform for table ${tagToString(table.tag)}`);
		else {
			tableData = decompressed.subarray(table.srcOffset, table.srcOffset + table.srcLength);
			if (table.tag === TAG_HEAD && tableData.byteLength >= 12) {
				tableData = new Uint8Array(tableData);
				new DataView(tableData.buffer, tableData.byteOffset).setUint32(8, 0);
			}
		}
		output.set(tableData, dstOffset);
		checksum = computeChecksum(output, dstOffset, tableData.byteLength);
		table.dstLength = tableData.byteLength;
		updateTableEntry(outView, entryOffset, checksum, dstOffset, tableData.byteLength);
		if (isTTC) {
			fontChecksum = fontChecksum + checksum >>> 0;
			fontChecksum = fontChecksum + computeTableEntryChecksum(checksum, dstOffset, tableData.byteLength) >>> 0;
		}
		writtenTables.set(tKey, {
			dstOffset,
			dstLength: tableData.byteLength,
			checksum
		});
		dstOffset += pad4(tableData.byteLength);
	}
	const headTable = sortedTables.find((t) => t.tag === TAG_HEAD);
	if (headTable) {
		const headEntry = writtenTables.get(headTable.key);
		if (headEntry && headEntry.dstLength >= 12) {
			const finalChecksum = isTTC ? fontChecksum : computeChecksum(output, 0, dstOffset);
			outView.setUint32(headEntry.dstOffset + 8, 2981146554 - finalChecksum >>> 0);
		}
	}
	return dstOffset;
}
function computeTableEntryChecksum(checksum, offset, length) {
	return checksum + offset + length >>> 0;
}
function makeByteStream(data, start, length) {
	return {
		data,
		pos: start,
		end: start + length
	};
}
function bsReadU8(stream) {
	if (stream.pos >= stream.end) throw new Error("Stream overflow");
	return stream.data[stream.pos++];
}
function bsReadU16(stream) {
	if (stream.pos + 2 > stream.end) throw new Error("Stream overflow");
	const idx = stream.pos;
	stream.pos = idx + 2;
	return stream.data[idx] << 8 | stream.data[idx + 1];
}
function bsReadS16(stream) {
	if (stream.pos + 2 > stream.end) throw new Error("Stream overflow");
	const idx = stream.pos;
	stream.pos = idx + 2;
	const val = stream.data[idx] << 8 | stream.data[idx + 1];
	return (val & 32768) !== 0 ? val - 65536 : val;
}
function fsReadU32(stream) {
	if (stream.pos + 4 > stream.end) throw new Error("Stream overflow");
	const idx = stream.pos;
	stream.pos = idx + 4;
	return stream.data[idx] * 16777216 + (stream.data[idx + 1] << 16 | stream.data[idx + 2] << 8 | stream.data[idx + 3]) >>> 0;
}
function bsSkip(stream, n) {
	if (stream.pos + n > stream.end || n < 0) throw new Error("Stream overflow");
	stream.pos += n;
}
function fsReadBytes(stream, n) {
	if (stream.pos + n > stream.end || n < 0) throw new Error("Stream overflow");
	const start = stream.pos;
	stream.pos += n;
	return stream.data.subarray(start, start + n);
}
function bsRead255UShort(stream) {
	const code = bsReadU8(stream);
	if (code === 253) return bsReadU16(stream);
	else if (code === 255) return 253 + bsReadU8(stream);
	else if (code === 254) return 506 + bsReadU8(stream);
	return code;
}
function reconstructGlyf(data, glyfTable, _locaTable, fontInfo) {
	const headerStream = makeByteStream(data, glyfTable.srcOffset, glyfTable.transformLength);
	bsReadU16(headerStream);
	const optionFlags = bsReadU16(headerStream);
	const numGlyphs = bsReadU16(headerStream);
	const indexFormat = bsReadU16(headerStream);
	fontInfo.numGlyphs = numGlyphs;
	fontInfo.indexFormat = indexFormat;
	const nContourStreamSize = fsReadU32(headerStream);
	const nPointsStreamSize = fsReadU32(headerStream);
	const flagStreamSize = fsReadU32(headerStream);
	const glyphStreamSize = fsReadU32(headerStream);
	const compositeStreamSize = fsReadU32(headerStream);
	const bboxStreamSize = fsReadU32(headerStream);
	const instructionStreamSize = fsReadU32(headerStream);
	let offset = headerStream.pos;
	const nContourStream = makeByteStream(data, offset, nContourStreamSize);
	offset += nContourStreamSize;
	const nPointsStream = makeByteStream(data, offset, nPointsStreamSize);
	offset += nPointsStreamSize;
	const flagStream = makeByteStream(data, offset, flagStreamSize);
	offset += flagStreamSize;
	const glyphStream = makeByteStream(data, offset, glyphStreamSize);
	offset += glyphStreamSize;
	const compositeStream = makeByteStream(data, offset, compositeStreamSize);
	offset += compositeStreamSize;
	const bboxStream = makeByteStream(data, offset, bboxStreamSize);
	offset += bboxStreamSize;
	const instructionStream = makeByteStream(data, offset, instructionStreamSize);
	const hasOverlapBitmap = (optionFlags & 1) !== 0;
	let overlapBitmap = null;
	if (hasOverlapBitmap) {
		const overlapBitmapLength = numGlyphs + 7 >> 3;
		overlapBitmap = data.subarray(offset + instructionStreamSize, offset + instructionStreamSize + overlapBitmapLength);
	}
	const bboxBitmap = fsReadBytes(bboxStream, numGlyphs + 31 >> 5 << 2);
	let glyfOutput = new Uint8Array(glyfTable.origLength * 2);
	let glyfOffset = 0;
	const locaValues = new Uint32Array(numGlyphs + 1);
	fontInfo.xMins = new Int16Array(numGlyphs);
	let contourEndsScratch = new Uint16Array(128);
	let flagsScratch = new Uint8Array(512);
	let xScratch = new Uint8Array(512);
	let yScratch = new Uint8Array(512);
	for (let glyphId = 0; glyphId < numGlyphs; glyphId++) {
		locaValues[glyphId] = glyfOffset;
		const nContours = bsReadS16(nContourStream);
		const haveBbox = (bboxBitmap[glyphId >> 3] & 128 >> (glyphId & 7)) !== 0;
		if (nContours === 0) {
			if (haveBbox) throw new Error(`Empty glyph ${glyphId} has bbox`);
			continue;
		}
		if (nContours === -1) {
			if (!haveBbox) throw new Error(`Composite glyph ${glyphId} missing bbox`);
			const { compositeData, haveInstructions } = readCompositeGlyph(compositeStream);
			let instructionSize = 0;
			if (haveInstructions) instructionSize = bsRead255UShort(glyphStream);
			const glyphSize = 10 + compositeData.byteLength + (haveInstructions ? 2 + instructionSize : 0);
			ensureCapacity(glyphSize);
			writeInt16BE(glyfOutput, glyfOffset, -1);
			const bbox = fsReadBytes(bboxStream, 8);
			glyfOutput.set(bbox, glyfOffset + 2);
			fontInfo.xMins[glyphId] = readInt16BE(bbox, 0);
			glyfOutput.set(compositeData, glyfOffset + 10);
			if (haveInstructions) {
				const instrOffset = glyfOffset + 10 + compositeData.byteLength;
				writeUint16BE(glyfOutput, instrOffset, instructionSize);
				const instructions = fsReadBytes(instructionStream, instructionSize);
				glyfOutput.set(instructions, instrOffset + 2);
			}
			glyfOffset += glyphSize;
			glyfOffset = pad4(glyfOffset);
		} else {
			if (nContours > contourEndsScratch.length) contourEndsScratch = new Uint16Array(nContours * 2);
			let totalPoints = 0;
			let endPoint = -1;
			for (let i = 0; i < nContours; i++) {
				const n = bsRead255UShort(nPointsStream);
				totalPoints += n;
				endPoint += n;
				contourEndsScratch[i] = endPoint;
			}
			const scratchSize = totalPoints * 2;
			if (scratchSize > flagsScratch.length) flagsScratch = new Uint8Array(scratchSize);
			if (scratchSize > xScratch.length) xScratch = new Uint8Array(scratchSize);
			if (scratchSize > yScratch.length) yScratch = new Uint8Array(scratchSize);
			const encoded = encodeTripletsToScratch(flagStream, glyphStream, totalPoints, ((overlapBitmap?.[glyphId >> 3] ?? 0) & 128 >> (glyphId & 7)) !== 0, flagsScratch, xScratch, yScratch);
			const instructionSize = bsRead255UShort(glyphStream);
			const glyphSize = 10 + 2 * nContours + 2 + instructionSize + encoded.flagsLen + encoded.xLen + encoded.yLen;
			ensureCapacity(glyphSize);
			writeInt16BE(glyfOutput, glyfOffset, nContours);
			let xMin = 0;
			if (haveBbox) {
				const bbox = fsReadBytes(bboxStream, 8);
				glyfOutput.set(bbox, glyfOffset + 2);
				xMin = readInt16BE(bbox, 0);
			} else {
				writeInt16BE(glyfOutput, glyfOffset + 2, encoded.xMin);
				writeInt16BE(glyfOutput, glyfOffset + 4, encoded.yMin);
				writeInt16BE(glyfOutput, glyfOffset + 6, encoded.xMax);
				writeInt16BE(glyfOutput, glyfOffset + 8, encoded.yMax);
				xMin = encoded.xMin;
			}
			let writeOffset = glyfOffset + 10;
			for (let i = 0; i < nContours; i++) {
				writeUint16BE(glyfOutput, writeOffset, contourEndsScratch[i]);
				writeOffset += 2;
			}
			writeUint16BE(glyfOutput, writeOffset, instructionSize);
			writeOffset += 2;
			if (instructionSize > 0) {
				const instructions = fsReadBytes(instructionStream, instructionSize);
				glyfOutput.set(instructions, writeOffset);
				writeOffset += instructionSize;
			}
			glyfOutput.set(flagsScratch.subarray(0, encoded.flagsLen), writeOffset);
			writeOffset += encoded.flagsLen;
			glyfOutput.set(xScratch.subarray(0, encoded.xLen), writeOffset);
			writeOffset += encoded.xLen;
			glyfOutput.set(yScratch.subarray(0, encoded.yLen), writeOffset);
			fontInfo.xMins[glyphId] = xMin;
			glyfOffset += glyphSize;
			glyfOffset = pad4(glyfOffset);
		}
	}
	locaValues[numGlyphs] = glyfOffset;
	const locaSize = indexFormat ? (numGlyphs + 1) * 4 : (numGlyphs + 1) * 2;
	const locaData = new Uint8Array(locaSize);
	const locaView = new DataView(locaData.buffer);
	for (let i = 0; i <= numGlyphs; i++) if (indexFormat) locaView.setUint32(i * 4, locaValues[i]);
	else locaView.setUint16(i * 2, locaValues[i] >> 1);
	return {
		glyfData: glyfOutput.subarray(0, glyfOffset),
		locaData
	};
	function ensureCapacity(needed) {
		if (glyfOffset + needed > glyfOutput.byteLength) {
			const newOutput = new Uint8Array((glyfOffset + needed) * 2);
			newOutput.set(glyfOutput);
			glyfOutput = newOutput;
		}
	}
}
function readCompositeGlyph(stream) {
	const FLAG_ARG_1_AND_2_ARE_WORDS = 1;
	const FLAG_WE_HAVE_A_SCALE = 8;
	const FLAG_MORE_COMPONENTS = 32;
	const FLAG_WE_HAVE_AN_X_AND_Y_SCALE = 64;
	const FLAG_WE_HAVE_A_TWO_BY_TWO = 128;
	const FLAG_WE_HAVE_INSTRUCTIONS = 256;
	const startOffset = stream.pos;
	let haveInstructions = false;
	let flags = FLAG_MORE_COMPONENTS;
	while (flags & FLAG_MORE_COMPONENTS) {
		flags = bsReadU16(stream);
		haveInstructions = haveInstructions || (flags & FLAG_WE_HAVE_INSTRUCTIONS) !== 0;
		let argSize = 2;
		if (flags & FLAG_ARG_1_AND_2_ARE_WORDS) argSize += 4;
		else argSize += 2;
		if (flags & FLAG_WE_HAVE_A_SCALE) argSize += 2;
		else if (flags & FLAG_WE_HAVE_AN_X_AND_Y_SCALE) argSize += 4;
		else if (flags & FLAG_WE_HAVE_A_TWO_BY_TWO) argSize += 8;
		bsSkip(stream, argSize);
	}
	return {
		compositeData: stream.data.subarray(startOffset, stream.pos),
		haveInstructions
	};
}
function encodeTripletsToScratch(flagStream, glyphStream, nPoints, hasOverlapBit, flagsOut, xOut, yOut) {
	if (nPoints === 0) return {
		flagsLen: 0,
		xLen: 0,
		yLen: 0,
		xMin: 0,
		yMin: 0,
		xMax: 0,
		yMax: 0
	};
	let flagsLen = 0;
	let xLen = 0;
	let yLen = 0;
	let x = 0;
	let y = 0;
	let xMin = 0;
	let yMin = 0;
	let xMax = 0;
	let yMax = 0;
	let lastFlag = -1;
	let repeatCount = 0;
	const flagData = flagStream.data;
	let flagPos = flagStream.pos;
	const flagEnd = flagStream.end;
	const glyphData = glyphStream.data;
	let glyphPos = glyphStream.pos;
	const glyphEnd = glyphStream.end;
	for (let i = 0; i < nPoints; i++) {
		if (flagPos >= flagEnd) throw new Error("Stream overflow");
		const flag = flagData[flagPos++];
		const onCurve = (flag & 128) === 0;
		const flagLow = flag & 127;
		let dx;
		let dy;
		if (flagLow < 10) {
			dx = 0;
			if (glyphPos >= glyphEnd) throw new Error("Stream overflow");
			const b = glyphData[glyphPos++];
			dy = ((flagLow & 14) << 7) + b;
			if ((flagLow & 1) === 0) dy = -dy;
		} else if (flagLow < 20) {
			if (glyphPos >= glyphEnd) throw new Error("Stream overflow");
			const b = glyphData[glyphPos++];
			dx = ((flagLow - 10 & 14) << 7) + b;
			if ((flagLow & 1) === 0) dx = -dx;
			dy = 0;
		} else if (flagLow < 84) {
			if (glyphPos >= glyphEnd) throw new Error("Stream overflow");
			const b = glyphData[glyphPos++];
			const b0 = flagLow - 20;
			dx = 1 + (b0 & 48) + (b >> 4);
			dy = 1 + ((b0 & 12) << 2) + (b & 15);
			if ((flagLow & 1) === 0) dx = -dx;
			if ((flagLow & 2) === 0) dy = -dy;
		} else if (flagLow < 120) {
			if (glyphPos + 1 >= glyphEnd) throw new Error("Stream overflow");
			const b0 = glyphData[glyphPos++];
			const b1 = glyphData[glyphPos++];
			const idx = flagLow - 84;
			dx = 1 + ((idx / 12 | 0) << 8) + b0;
			dy = 1 + (idx % 12 >> 2 << 8) + b1;
			if ((flagLow & 1) === 0) dx = -dx;
			if ((flagLow & 2) === 0) dy = -dy;
		} else if (flagLow < 124) {
			if (glyphPos + 2 >= glyphEnd) throw new Error("Stream overflow");
			const b0 = glyphData[glyphPos++];
			const b1 = glyphData[glyphPos++];
			const b2 = glyphData[glyphPos++];
			dx = (b0 << 4) + (b1 >> 4);
			dy = ((b1 & 15) << 8) + b2;
			if ((flagLow & 1) === 0) dx = -dx;
			if ((flagLow & 2) === 0) dy = -dy;
		} else {
			if (glyphPos + 3 >= glyphEnd) throw new Error("Stream overflow");
			const b0 = glyphData[glyphPos++];
			const b1 = glyphData[glyphPos++];
			const b2 = glyphData[glyphPos++];
			const b3 = glyphData[glyphPos++];
			dx = (b0 << 8) + b1;
			dy = (b2 << 8) + b3;
			if ((flagLow & 1) === 0) dx = -dx;
			if ((flagLow & 2) === 0) dy = -dy;
		}
		x += dx;
		y += dy;
		if (i === 0) {
			xMin = xMax = x;
			yMin = yMax = y;
		} else {
			if (x < xMin) xMin = x;
			if (x > xMax) xMax = x;
			if (y < yMin) yMin = y;
			if (y > yMax) yMax = y;
		}
		let outFlag = onCurve ? FLAG_ON_CURVE : 0;
		if (hasOverlapBit && i === 0) outFlag |= FLAG_OVERLAP_SIMPLE;
		if (dx === 0) outFlag |= FLAG_X_SAME;
		else if (dx >= -255 && dx <= 255) {
			outFlag |= FLAG_X_SHORT;
			if (dx > 0) outFlag |= FLAG_X_SAME;
			xOut[xLen++] = dx > 0 ? dx : -dx;
		} else {
			xOut[xLen++] = dx >> 8 & 255;
			xOut[xLen++] = dx & 255;
		}
		if (dy === 0) outFlag |= FLAG_Y_SAME;
		else if (dy >= -255 && dy <= 255) {
			outFlag |= FLAG_Y_SHORT;
			if (dy > 0) outFlag |= FLAG_Y_SAME;
			yOut[yLen++] = dy > 0 ? dy : -dy;
		} else {
			yOut[yLen++] = dy >> 8 & 255;
			yOut[yLen++] = dy & 255;
		}
		if (outFlag === lastFlag && repeatCount < 255) {
			flagsOut[flagsLen - 1] |= FLAG_REPEAT;
			repeatCount++;
		} else {
			if (repeatCount > 0) {
				flagsOut[flagsLen++] = repeatCount;
				repeatCount = 0;
			}
			flagsOut[flagsLen++] = outFlag;
			lastFlag = outFlag;
		}
	}
	if (repeatCount > 0) flagsOut[flagsLen++] = repeatCount;
	flagStream.pos = flagPos;
	glyphStream.pos = glyphPos;
	return {
		flagsLen,
		xLen,
		yLen,
		xMin,
		yMin,
		xMax,
		yMax
	};
}
function reconstructHmtx(data, table, numGlyphs, numHMetrics, xMins) {
	const hmtxStream = makeByteStream(data, table.srcOffset, table.srcLength);
	const hmtxFlags = bsReadU8(hmtxStream);
	const hasProportionalLsbs = (hmtxFlags & 1) === 0;
	const hasMonospaceLsbs = (hmtxFlags & 2) === 0;
	const advanceWidths = new Uint16Array(numHMetrics);
	for (let i = 0; i < numHMetrics; i++) advanceWidths[i] = bsReadU16(hmtxStream);
	const lsbs = new Int16Array(numGlyphs);
	for (let i = 0; i < numHMetrics; i++) if (hasProportionalLsbs) lsbs[i] = bsReadS16(hmtxStream);
	else lsbs[i] = xMins[i];
	for (let i = numHMetrics; i < numGlyphs; i++) if (hasMonospaceLsbs) lsbs[i] = bsReadS16(hmtxStream);
	else lsbs[i] = xMins[i];
	const outputSize = numHMetrics * 4 + (numGlyphs - numHMetrics) * 2;
	const output = new Uint8Array(outputSize);
	let offset = 0;
	for (let i = 0; i < numGlyphs; i++) {
		if (i < numHMetrics) {
			writeUint16BE(output, offset, advanceWidths[i]);
			offset += 2;
		}
		writeInt16BE(output, offset, lsbs[i]);
		offset += 2;
	}
	return output;
}
function updateTableEntry(view, entryOffset, checksum, offset, length) {
	view.setUint32(entryOffset + 4, checksum);
	view.setUint32(entryOffset + 8, offset);
	view.setUint32(entryOffset + 12, length);
}
function readInt16BE(data, offset) {
	const val = data[offset] << 8 | data[offset + 1];
	return (val & 32768) !== 0 ? val - 65536 : val;
}
function writeInt16BE(data, offset, value) {
	data[offset] = value >> 8 & 255;
	data[offset + 1] = value & 255;
}
function writeUint16BE(data, offset, value) {
	data[offset] = value >> 8 & 255;
	data[offset + 1] = value & 255;
}

//#endregion
export { woff2Decode };
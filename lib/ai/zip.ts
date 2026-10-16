/**
 * A minimal, hostile-input-tolerant ZIP reader — just enough for `.docx`.
 *
 * DOCX files are ZIP containers; the text lives in `word/document.xml`. The
 * repo deliberately adds no archive dependency for one entry, so this module
 * parses the two ZIP structures that matter (central directory + local
 * header) against `node:zlib`'s raw inflater.
 *
 * Threat model: the archive is attacker-supplied bytes. Therefore
 *
 *   * every offset/length is bounds-checked against the buffer before a
 *     slice; a malformed structure yields `null`, never an exception and
 *     never an out-of-range read;
 *   * entry count and uncompressed size are capped (zip-bomb guard) — a
 *     42 KB header must not be able to ask for gigabytes;
 *   * decompression runs through `inflateRawSync` inside try/catch: a
 *     corrupt stream is `null`, not a crash;
 *   * nothing is extracted to disk and no path is ever interpreted — an
 *     entry is selected by exact name comparison only.
 */

import { inflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/** Bounds on what a single entry may ask the reader to produce. */
const MAX_ENTRIES = 10_000;
const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;

function readU16(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 2 > bytes.length) {
    return null;
  }
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) {
    return null;
  }
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function decoder(): TextDecoder {
  // Fatal: invalid UTF-8 inside an XML part is corrupt input, not text to fix.
  return new TextDecoder("utf-8", { fatal: true });
}

/**
 * Locates the End Of Central Directory record. Its offset is not fixed (the
 * archive may end with arbitrary comment bytes), so the last 64 KiB + 22 is
 * scanned backwards for the signature.
 */
function findEndOfCentralDirectory(bytes: Uint8Array): number | null {
  const minimum = 22;
  if (bytes.length < minimum) {
    return null;
  }
  const scanFloor = Math.max(0, bytes.length - (0xffff + minimum));
  for (let offset = bytes.length - minimum; offset >= scanFloor; offset -= 1) {
    if (readU32(bytes, offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  return null;
}

/**
 * Returns the decompressed bytes of exactly one entry, or `null` when the
 * archive is malformed, the entry is absent, the method is unsupported, or a
 * cap would be exceeded. Callers treat every `null` as "cannot extract".
 */
export function readZipEntry(
  bytes: Uint8Array,
  entryName: string,
): Uint8Array | null {
  try {
    return readEntryInner(bytes, entryName);
  } catch {
    // Defence in depth: the checks below are meant to make this unreachable,
    // but a reader of untrusted bytes never lets an exception escape.
    return null;
  }
}

function readEntryInner(bytes: Uint8Array, entryName: string): Uint8Array | null {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd === null) {
    return null;
  }

  const totalEntries = readU16(bytes, eocd + 10);
  const centralSize = readU32(bytes, eocd + 12);
  const centralOffset = readU32(bytes, eocd + 16);
  if (
    totalEntries === null ||
    centralSize === null ||
    centralOffset === null ||
    totalEntries < 1 ||
    totalEntries > MAX_ENTRIES
  ) {
    return null;
  }
  if (centralOffset + centralSize > bytes.length) {
    return null;
  }

  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readU32(bytes, cursor) !== CENTRAL_DIRECTORY_HEADER) {
      return null;
    }

    const method = readU16(bytes, cursor + 10);
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const localOffset = readU32(bytes, cursor + 42);
    if (
      method === null ||
      compressedSize === null ||
      uncompressedSize === null ||
      nameLength === null ||
      extraLength === null ||
      commentLength === null ||
      localOffset === null
    ) {
      return null;
    }

    const nameStart = cursor + 46;
    if (nameStart + nameLength > bytes.length) {
      return null;
    }
    let name: string;
    try {
      name = decoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    } catch {
      return null;
    }

    if (name === entryName) {
      if (uncompressedSize > MAX_UNCOMPRESSED_BYTES) {
        return null;
      }
      if (
        method !== METHOD_STORED &&
        method !== METHOD_DEFLATED
      ) {
        return null;
      }
      return extractLocal(bytes, localOffset, method, compressedSize, uncompressedSize);
    }

    cursor = nameStart + nameLength + extraLength + commentLength;
    if (cursor > centralOffset + centralSize) {
      return null;
    }
  }

  return null;
}

function extractLocal(
  bytes: Uint8Array,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array | null {
  if (readU32(bytes, localOffset) !== LOCAL_FILE_HEADER) {
    return null;
  }
  const nameLength = readU16(bytes, localOffset + 26);
  const extraLength = readU16(bytes, localOffset + 28);
  if (nameLength === null || extraLength === null) {
    return null;
  }

  // Sizes come from the central directory, which is authoritative even when
  // the local header defers them to a data descriptor (bit 3).
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataStart < 0 || dataEnd > bytes.length || dataEnd < dataStart) {
    return null;
  }
  const compressed = bytes.subarray(dataStart, dataEnd);

  if (method === METHOD_STORED) {
    if (compressed.length !== uncompressedSize) {
      return null;
    }
    return compressed.slice();
  }

  try {
    const inflated = inflateRawSync(Buffer.from(compressed), {
      maxOutputLength: MAX_UNCOMPRESSED_BYTES,
    });
    if (inflated.length !== uncompressedSize) {
      // A size lie is corruption: trusting either number alone would let the
      // archive disagree with itself.
      return null;
    }
    return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength).slice();
  } catch {
    return null;
  }
}

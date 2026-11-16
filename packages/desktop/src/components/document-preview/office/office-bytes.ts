/**
 * Byte-level checks before handing a file to the ooxml engine.
 *
 * Office files are ZIP archives. The engine degrades rather than rejects on
 * some broken archives (a truncated workbook opens as a sheet named
 * "(zip container)"), and its strict preflight rejects archives Office and
 * `unzip` accept: bytes after the end-of-central-directory record (a newline
 * from a text-mode transfer, an appended signature). So:
 *  - no ZIP end record → a clear "not a valid Office document" error;
 *  - trailing bytes after it → cut off.
 * OLE compound files (encrypted OOXML, legacy .doc/.xls/.ppt) pass through:
 * the engine reports those with precise error codes.
 */
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
/** How much trailing junk is searched past a maximal comment. */
const MAX_TRAILER = 4096;
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Same `code` as the engine's own container error, so both read the same to the user. */
export class NotOfficeFileError extends Error {
  readonly code = "not-ooxml";
  constructor() {
    super("No ZIP end-of-central-directory record");
    this.name = "NotOfficeFileError";
  }
}

function isCompoundFile(data: ArrayBuffer): boolean {
  const head = new Uint8Array(data, 0, Math.min(CFB_SIGNATURE.length, data.byteLength));
  return CFB_SIGNATURE.every((byte, index) => head[index] === byte);
}

/** Offset just past the last end-of-central-directory record and its comment. */
function zipEnd(data: ArrayBuffer): number | null {
  const view = new DataView(data);
  const lowest = Math.max(0, data.byteLength - EOCD_SIZE - MAX_COMMENT - MAX_TRAILER);
  for (let start = data.byteLength - EOCD_SIZE; start >= lowest; start -= 1) {
    if (view.getUint32(start, true) !== EOCD_SIGNATURE) continue;
    const end = start + EOCD_SIZE + view.getUint16(start + 20, true);
    if (end <= data.byteLength) return end;
  }
  return null;
}

/**
 * A copy of `data` ready for the engine (the caller's buffer is never handed
 * over), or an error when it can't be an Office file.
 */
export function prepareOfficeBytes(data: ArrayBuffer): ArrayBuffer {
  if (isCompoundFile(data)) return data.slice(0);
  const end = zipEnd(data);
  if (end === null) throw new NotOfficeFileError();
  return data.slice(0, end);
}

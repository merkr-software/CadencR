import { describe, expect, it } from "vitest";
import { NotOfficeFileError, prepareOfficeBytes } from "./office-bytes";

/** A minimal empty archive: just an end-of-central-directory record. */
function eocd(comment = ""): Uint8Array {
  const commentBytes = new TextEncoder().encode(comment);
  const record = new Uint8Array(22 + commentBytes.length);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(20, commentBytes.length, true);
  record.set(commentBytes, 22);
  return record;
}

function concat(...parts: Uint8Array[]): ArrayBuffer {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out.buffer;
}

const ENTRIES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const bytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer);

describe("prepareOfficeBytes", () => {
  it("drops bytes after the end-of-central-directory record", () => {
    const clean = concat(ENTRIES, eocd());
    const prepared = prepareOfficeBytes(concat(ENTRIES, eocd(), new Uint8Array([0x0a])));
    expect(bytes(prepared)).toEqual(bytes(clean));
  });

  it("keeps the archive comment", () => {
    const clean = concat(ENTRIES, eocd("signed"));
    const prepared = prepareOfficeBytes(
      concat(ENTRIES, eocd("signed"), new Uint8Array([0, 0, 0x0a])),
    );
    expect(bytes(prepared)).toEqual(bytes(clean));
  });

  it("returns an untouched copy of a clean archive", () => {
    const clean = concat(ENTRIES, eocd());
    const prepared = prepareOfficeBytes(clean);
    expect(prepared).not.toBe(clean);
    expect(bytes(prepared)).toEqual(bytes(clean));
  });

  it("passes OLE compound files (encrypted / legacy Office) through as a copy", () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 9, 9]).buffer;
    expect(bytes(prepareOfficeBytes(cfb))).toEqual(bytes(cfb));
  });

  it("rejects data that isn't a complete ZIP", () => {
    const text = new TextEncoder().encode("not an archive").buffer;
    expect(() => prepareOfficeBytes(text)).toThrow(NotOfficeFileError);
    expect(() => prepareOfficeBytes(ENTRIES.slice().buffer)).toThrow(NotOfficeFileError);
    expect(() => prepareOfficeBytes(new ArrayBuffer(0))).toThrow(NotOfficeFileError);
  });
});

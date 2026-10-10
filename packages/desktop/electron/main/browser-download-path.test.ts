import {
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  removeEmptyBrowserDownloadReservation,
  releaseBrowserDownloadReservation,
  reserveBrowserDownloadPath,
  sanitizeBrowserDownloadFilename,
} from "./browser-download-path";
import { descriptorReleased } from "./test-descriptor";

const roots: string[] = [];

function testDirectory(): string {
  const root = path.join(tmpdir(), `cadencr-download-path-${process.pid}-${roots.length}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("browser download paths", () => {
  it("sanitizes traversal, controls, bidi text, Windows-invalid characters, and device names", () => {
    expect(sanitizeBrowserDownloadFilename("../a\\b\u202esecret:<x>?*.txt")).toBe(
      "b_secret__x___.txt",
    );
    expect(sanitizeBrowserDownloadFilename("CON.txt")).toBe("_CON.txt");
    expect(sanitizeBrowserDownloadFilename("..\u0000")).toBe("_");
  });

  it("atomically chooses a unique name without replacing an existing file", () => {
    const directory = testDirectory();
    const existing = path.join(directory, "report.txt");
    writeFileSync(existing, "keep");
    const reservation = reserveBrowserDownloadPath(directory, "report.txt");

    expect(path.basename(reservation.path)).toBe("report (1).txt");
    expect(readFileSync(existing, "utf8")).toBe("keep");
    removeEmptyBrowserDownloadReservation(reservation);
    expect(() => readFileSync(reservation.path)).toThrow();
  });

  it("never removes a reservation that another writer replaced or filled", () => {
    const directory = testDirectory();
    const filled = reserveBrowserDownloadPath(directory, "filled.bin");
    writeFileSync(filled.path, "downloaded");
    removeEmptyBrowserDownloadReservation(filled);
    expect(readFileSync(filled.path, "utf8")).toBe("downloaded");

    const replaced = reserveBrowserDownloadPath(directory, "replaced.bin");
    const originalDescriptor = replaced.descriptor!;
    rmSync(replaced.path);
    expect(fstatSync(originalDescriptor).nlink).toBe(0);
    const descriptor = openSync(replaced.path, "wx");
    expect(fstatSync(descriptor).ino).not.toBe(replaced.inode);
    closeSync(descriptor);
    removeEmptyBrowserDownloadReservation(replaced);
    expect(descriptorReleased(originalDescriptor, replaced)).toBe(true);
    expect(readFileSync(replaced.path)).toHaveLength(0);
  });

  it("keeps multibyte numbered and UUID-fallback names within the byte limit", () => {
    const directory = testDirectory();
    const hostile = `${"🦊".repeat(100)}.${"界".repeat(100)}`;
    for (let index = 0; index < 101; index += 1) {
      const reservation = reserveBrowserDownloadPath(directory, hostile);
      expect(Buffer.byteLength(path.basename(reservation.path))).toBeLessThanOrEqual(180);
      releaseBrowserDownloadReservation(reservation);
    }
  });

  it("preserves a normal extension while truncating an overlong multibyte stem", () => {
    const filename = sanitizeBrowserDownloadFilename(`${"🦊".repeat(100)}.pdf`);
    expect(filename.endsWith(".pdf")).toBe(true);
    expect(Buffer.byteLength(filename)).toBeLessThanOrEqual(180);
  });
});

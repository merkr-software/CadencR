import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

const MAX_FILENAME_BYTES = 180;
const MAX_EXTENSION_BYTES = 32;
const NUMBERED_ATTEMPTS = 100;
// Deliberately replace the C0 and DEL ranges; download names are an OS boundary.
const UNSAFE_FILENAME_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f/<>:"|?*\\\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const WINDOWS_RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export interface BrowserDownloadReservation {
  path: string;
  device: number;
  inode: number;
  descriptor: number | null;
}

/** Atomically reserve a destination that did not exist before this download. */
export function reserveBrowserDownloadPath(
  directory: string,
  rawFilename: string,
): BrowserDownloadReservation {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = sanitizeBrowserDownloadFilename(rawFilename);
  for (let attempt = 0; attempt < NUMBERED_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? filename : withSuffix(filename, ` (${attempt})`);
    const reservation = tryReserve(directory, candidate);
    if (reservation) return reservation;
  }
  const fallback = withSuffix(filename, `-${randomUUID()}`);
  const reservation = tryReserve(directory, fallback);
  if (reservation) return reservation;
  throw new Error("Could not reserve a unique download destination.");
}

/** Remove only the exact, still-empty inode created by this reservation. */
export function removeEmptyBrowserDownloadReservation(
  reservation: BrowserDownloadReservation,
): void {
  if (reservation.descriptor === null) return;
  try {
    removeReservedEmptyFile(reservation);
  } finally {
    releaseBrowserDownloadReservation(reservation);
  }
}

export function releaseBrowserDownloadReservation(reservation: BrowserDownloadReservation): void {
  const descriptor = reservation.descriptor;
  if (descriptor === null) return;
  reservation.descriptor = null;
  closeSync(descriptor);
}

function removeReservedEmptyFile(reservation: BrowserDownloadReservation): void {
  let stat;
  try {
    stat = lstatSync(reservation.path);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (
    stat.isFile() &&
    stat.dev === reservation.device &&
    stat.ino === reservation.inode &&
    stat.size === 0
  ) {
    unlinkSync(reservation.path);
  }
}

export function sanitizeBrowserDownloadFilename(rawFilename: string): string {
  const leaf = rawFilename.normalize("NFKC").replaceAll("\\", "/").split("/").at(-1) ?? "";
  const cleaned = leaf
    .replace(UNSAFE_FILENAME_CHARACTERS, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  const safe = WINDOWS_RESERVED_FILENAME.test(cleaned) ? `_${cleaned}` : cleaned;
  return truncateFilename(safe || "download");
}

function tryReserve(directory: string, filename: string): BrowserDownloadReservation | null {
  const destination = path.join(directory, filename);
  const flags =
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  let descriptor: number;
  try {
    descriptor = openSync(destination, flags, 0o600);
  } catch (error) {
    if (isExistingFile(error)) return null;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    // Keep the inode allocated even if another writer unlinks the placeholder.
    return { path: destination, device: stat.dev, inode: stat.ino, descriptor };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function withSuffix(filename: string, suffix: string): string {
  const rawExtension = path.extname(filename);
  const extension = truncateUtf8(rawExtension, MAX_EXTENSION_BYTES);
  const stem = rawExtension ? filename.slice(0, -rawExtension.length) : filename;
  const allowed = MAX_FILENAME_BYTES - Buffer.byteLength(suffix) - Buffer.byteLength(extension);
  return `${truncateUtf8(stem, allowed) || "d"}${suffix}${extension}`;
}

function truncateFilename(filename: string): string {
  const rawExtension = path.extname(filename);
  const extension = truncateUtf8(rawExtension, MAX_EXTENSION_BYTES);
  const stem = rawExtension ? filename.slice(0, -rawExtension.length) : filename;
  const allowed = MAX_FILENAME_BYTES - Buffer.byteLength(extension);
  return `${truncateUtf8(stem, allowed) || "download"}${extension}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character) > maxBytes) break;
    output += character;
  }
  return output;
}

function isExistingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

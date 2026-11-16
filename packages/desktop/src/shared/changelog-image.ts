/** An image referenced by release notes, fetched by the main process for the renderer. */
export interface ChangelogImageBytes {
  data: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

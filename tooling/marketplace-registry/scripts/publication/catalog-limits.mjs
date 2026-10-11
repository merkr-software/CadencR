// Serialized signed envelope budget, including its trailing newline. Requests
// and submissions retain independent 1 MiB limits. Mirrors registry-core.
export const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
// Git blob JSON carries base64 plus line breaks and bounded response metadata.
export const MAX_CATALOG_BLOB_JSON_BYTES = Math.ceil(MAX_CATALOG_BYTES / 3) * 4 + 2 * 1024 * 1024;

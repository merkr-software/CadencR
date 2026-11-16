/** Desktop uses main's runtime endpoint; a plain HTTP browser uses Vite's credentialed proxy. */
export function developmentApiBaseUrl(): string {
  if (
    typeof window !== "undefined" &&
    typeof location !== "undefined" &&
    !window.cadencr &&
    location.protocol === "http:"
  ) {
    return location.origin;
  }
  const configured = import.meta.env.VITE_API_URL;
  return typeof configured === "string" && configured.length > 0
    ? configured.replace(/\/$/, "")
    : "http://127.0.0.1:5005";
}

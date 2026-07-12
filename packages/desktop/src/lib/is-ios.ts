/** True on any iOS/iPadOS device (all iOS browsers are WebKit). */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports as a Mac; disambiguate via touch support.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

// Every brand asset the desktop app ships: the in-app logo SVGs, the PWA and
// favicon set served to browsers (remote access), and the Electron app icons.
//
// Root-level copies (favicon.ico, apple-touch-icon*.png) matter: browsers and
// iOS auto-probe them, and our SPA answers unknown paths with index.html, which
// iOS treats as a broken icon.
import {
  adaptiveFaviconSvg,
  appIconSvg,
  faviconIcoEntries,
  markSvg,
  tileStandard,
  tileSvg,
} from "../svg/mark.mjs";
import {
  EMERALD,
  EMERALD_DEEP,
  FAVICON_CUT as FAV,
  INK,
  INK_LIGHT,
  STANDARD_CUT as STD,
} from "../tokens.mjs";

const appStandard = () => appIconSvg(STD, 17);
const appSmall = () => appIconSvg(FAV, 16);

export const desktop = {
  name: "desktop",
  root: "packages/desktop",
  assets: [
    // ─── In-app logo (consumed by src/lib/themes/logos.ts) ─────────────────
    { path: "assets/cadencr-mark-dark.svg", kind: "svg", svg: () => markSvg(STD, INK, EMERALD) },
    {
      path: "assets/cadencr-mark-light.svg",
      kind: "svg",
      svg: () => markSvg(STD, INK_LIGHT, EMERALD_DEEP),
    },

    // ─── PWA + favicon set (public/, linked from index.html) ───────────────
    // Homescreen tiles are opaque: iOS ignores apple-touch-icons with alpha.
    { path: "public/favicon.svg", kind: "svg", svg: () => adaptiveFaviconSvg(FAV) },
    { path: "public/favicon.ico", kind: "ico", entries: faviconIcoEntries() },
    {
      path: "public/apple-touch-icon.png",
      kind: "png",
      size: 180,
      opaque: true,
      svg: tileStandard,
    },
    {
      path: "public/apple-touch-icon-precomposed.png",
      kind: "png",
      size: 180,
      opaque: true,
      svg: tileStandard,
    },
    { path: "public/icons/icon-192.png", kind: "png", size: 192, opaque: true, svg: tileStandard },
    { path: "public/icons/icon-512.png", kind: "png", size: 512, opaque: true, svg: tileStandard },
    // Maskable: mark shrunk inside the safe circle so squircle/circle crops keep it.
    {
      path: "public/icons/icon-maskable-512.png",
      kind: "png",
      size: 512,
      opaque: true,
      svg: () => tileSvg(STD, 0.74),
    },

    // ─── Electron app icons (icons/, referenced by electron-builder) ───────
    // Linux packages consume the PNG directory and select the closest size.
    { path: "icons/16x16.png", kind: "png", size: 16, svg: appSmall },
    { path: "icons/32x32.png", kind: "png", size: 32, svg: appSmall },
    { path: "icons/48x48.png", kind: "png", size: 48, svg: appStandard },
    { path: "icons/64x64.png", kind: "png", size: 64, svg: appStandard },
    { path: "icons/128x128.png", kind: "png", size: 128, svg: appStandard },
    { path: "icons/256x256.png", kind: "png", size: 256, svg: appStandard },
    { path: "icons/512x512.png", kind: "png", size: 512, svg: appStandard },
    { path: "icons/icon.png", kind: "png", size: 512, svg: appStandard },
    {
      path: "icons/icon.ico",
      kind: "ico",
      entries: [
        { size: 16, svg: appSmall },
        { size: 32, svg: appSmall },
        { size: 48, svg: appSmall },
        { size: 256, svg: appStandard },
      ],
    },
    // Retina pairs intentionally repeat physical sizes under their scale-aware
    // chunk identifiers; only ≤32px entries take the thicker favicon cut.
    {
      path: "icons/icon.icns",
      kind: "icns",
      entries: [
        { type: "ic04", size: 16, svg: appSmall },
        { type: "ic11", size: 32, svg: appSmall },
        { type: "ic05", size: 32, svg: appSmall },
        { type: "ic12", size: 64, svg: appStandard },
        { type: "ic07", size: 128, svg: appStandard },
        { type: "ic13", size: 256, svg: appStandard },
        { type: "ic08", size: 256, svg: appStandard },
        { type: "ic14", size: 512, svg: appStandard },
        { type: "ic09", size: 512, svg: appStandard },
        { type: "ic10", size: 1024, svg: appStandard },
      ],
    },
  ],
};

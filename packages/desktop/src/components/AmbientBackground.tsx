import { memo, useEffect, useMemo, useRef } from "react";
import { useHaloOverride } from "@/hooks/useHaloOverride";
import { useLavaMotion } from "@/hooks/useLavaMotion";
import { useTheme } from "@/hooks/useTheme";
import { chromeOf, hasTexture, type ThemeHalo, type ThemeTexture } from "@/lib/themes/chrome";
import {
  glowSeconds,
  lavaSpeed,
  orbitSeconds,
  resolveTextureHalos,
  type HaloOverride,
} from "@/lib/themes";

/**
 * The texture behind the app — the active theme's drifting halos, image and
 * grain, fixed at `z-index: -1` under everything.
 *
 * Every layer comes from `theme.chrome.texture` rather than from a stylesheet
 * keyed on a theme id, which is what lets a theme duplicated from Frost keep
 * its field, and any other theme describe one of its own. A theme with no
 * texture renders nothing at all: no element, no blend, no compositing.
 *
 * The user's own tuning of the halos (`useHaloOverride`) is applied here, on
 * the way to the DOM, so the theme's data stays the theme's and the override
 * stays a transform over it.
 *
 * The one piece of JS motion gating: drift runs at the display refresh rate
 * (e.g. 120fps), which keeps the GPU compositing every vsync even when the
 * window is hidden or sitting unfocused on another monitor — pure battery
 * waste. We toggle `data-ambient-paused` on <html> on visibility/focus changes
 * and let CSS pause the animation, so a backgrounded window composites zero
 * frames. Drift also freezes under the global motion kill-switch
 * (`html[data-animations="off"]`, which reflects OS reduced-motion).
 *
 * `aria-hidden` because it is pure decoration.
 */
export function AmbientBackground(): React.JSX.Element | null {
  const { theme } = useTheme();
  const { override } = useHaloOverride(theme.id);
  const texture = useMemo(
    () => resolveTextureHalos(chromeOf(theme).texture, override),
    [theme, override],
  );
  const painted = hasTexture(texture);

  useEffect(() => {
    if (!painted) return;
    const root = document.documentElement;
    const sync = (): void => {
      const paused = document.hidden || !document.hasFocus();
      root.toggleAttribute("data-ambient-paused", paused);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      root.removeAttribute("data-ambient-paused");
    };
  }, [painted]);

  if (!painted) return null;
  return <TextureLayers texture={texture} assets={theme.assets ?? NO_ASSETS} override={override} />;
}

/** Stable identity, so a built-in theme's layers don't re-render on every
 *  settings change that passes through `useTheme`. */
const NO_ASSETS: Record<string, string> = {};

const TextureLayers = memo(function TextureLayers({
  texture,
  assets,
  override,
}: {
  texture: ThemeTexture;
  assets: Record<string, string>;
  override: HaloOverride;
}): React.JSX.Element {
  const { base, halos, image, grain, veil } = texture;
  const imageUrl = image ? assets[image.asset] : undefined;
  const ambientRef = useRef<HTMLDivElement>(null);
  const orbit = orbitSeconds(override);
  useLavaMotion(ambientRef, halos, lavaSpeed(override));

  return (
    <>
      <div
        ref={ambientRef}
        className="ambient"
        aria-hidden="true"
        // The orbit turns the whole field around the viewport centre, which is
        // the one thing a per-halo transform cannot do without fighting the
        // drift. The attribute also lifts `overflow: hidden` — a rotated box
        // would otherwise clip the halos at its own edges.
        data-orbit={orbit === null ? undefined : ""}
        style={{
          backgroundColor: base ?? undefined,
          animationName: orbit === null ? undefined : "cadencr-orbit",
          animationDuration: orbit === null ? undefined : `${orbit}s`,
        }}
      >
        {halos.map((halo, index) => (
          <Halo key={index} halo={halo} index={index} override={override} />
        ))}
      </div>

      {image && imageUrl ? (
        <div
          className="texture-image"
          aria-hidden="true"
          style={{
            backgroundImage: `url("${imageUrl}")`,
            backgroundSize: image.fit === "tile" ? `${image.scale}px` : image.fit,
            backgroundRepeat: image.fit === "tile" ? "repeat" : "no-repeat",
            opacity: image.opacity,
            mixBlendMode: image.blend,
          }}
        />
      ) : null}

      {grain ? (
        <div
          className="grain"
          aria-hidden="true"
          style={{
            backgroundColor: grain.color,
            maskImage: GRAIN_MASK,
            maskSize: `${grain.scale}px`,
            opacity: grain.opacity,
            mixBlendMode: grain.blend,
          }}
        />
      ) : null}

      {/* Rendered last so it dims the layers above the page background rather
       * than being dimmed by them. This is the tint a translucent `body` used
       * to cast, moved off `body` because a partial-alpha backdrop root stops
       * `backdrop-filter` painting entirely (see theme-frost.css). */}
      {veil ? <div className="ambient-veil" aria-hidden="true" /> : null}
    </>
  );
});

/** `--halo-opacity` is a custom property, which `CSSProperties` does not model. */
type HaloStyle = React.CSSProperties & { "--halo-opacity": number };

/**
 * A halo is positioned by its centre, so `size` (a diameter in `vw`) is pulled
 * back by half on each axis with margins rather than a transform — `transform`
 * belongs to the drift animation, and the two would fight.
 *
 * Under `lava` the drift is dropped entirely: the simulation owns `transform`,
 * and a CSS animation on the same property would win over the inline value the
 * loop writes.
 */
function Halo({
  halo,
  index,
  override,
}: {
  halo: ThemeHalo;
  index: number;
  override: HaloOverride;
}): React.JSX.Element {
  const style = useMemo<HaloStyle>(() => {
    const drifting = halo.drift > 0 && override.motion !== "lava";
    const glow = glowSeconds(override);
    const names: string[] = [];
    const durations: string[] = [];
    const easings: string[] = [];
    const delays: string[] = [];

    if (drifting) {
      // Three drift paths, handed out in rotation: a theme with several halos
      // gets motion that never lines up. The easing and the frame cap come from
      // `theme-chrome.css`, so they are only restated here when a second
      // animation needs its own.
      names.push(`cadencr-drift-${(index % 3) + 1}`);
      durations.push(`${halo.drift}s`);
    }
    if (glow !== null) {
      // Each halo breathes on its own period and starts mid-cycle, so the
      // field pulses as a whole rather than blinking in unison.
      names.push("cadencr-glow");
      durations.push(`${(glow * (1 + index * 0.17)).toFixed(2)}s`);
      easings.push("ease-in-out");
      // A negative delay starts the animation mid-cycle. The first halo has
      // none, so it is not written as `-0.00s`.
      delays.push(index === 0 ? "0s" : `${(-glow * index * 0.31).toFixed(2)}s`);
    }

    return {
      width: `${halo.size}vw`,
      height: `${halo.size}vw`,
      left: `${halo.x}%`,
      top: `${halo.y}%`,
      marginLeft: `${-halo.size / 2}vw`,
      marginTop: `${-halo.size / 2}vw`,
      background: `radial-gradient(circle, ${halo.color}, transparent 70%)`,
      // No `filter` at all at zero, rather than `blur(0px)`: any filter value
      // gives the element its own rasterization pass, redone on every resize.
      filter: halo.blur > 0 ? `blur(${halo.blur}px)` : undefined,
      // The one source of the halo's strength: `.halo` reads it back as its
      // `opacity`, and the glow keyframes pulse around it.
      "--halo-opacity": halo.opacity,
      animationName: names.length > 0 ? names.join(", ") : undefined,
      animationDuration: durations.length > 0 ? durations.join(", ") : undefined,
      // Only when the glow is there: with the drift alone, the stylesheet's
      // `steps()` is already the right easing and restating it is noise.
      animationTimingFunction: easings.length > 0 ? easings.join(", ") : undefined,
      animationDelay: delays.length > 0 ? delays.join(", ") : undefined,
    };
  }, [halo, index, override]);

  return <div className="halo" style={style} />;
}

/**
 * The grain speckle, as an alpha mask rather than a colored image: the theme's
 * own `grain.color` fills the layer and this only decides where it shows. That
 * is what makes the color configurable at all — tinting the noise itself would
 * mean baking RGB into an feColorMatrix.
 *
 * `fractalNoise` at 0.7 with three octaves is the same speckle the Frost themes
 * have always used; the 0.7 alpha row keeps its density identical.
 */
const GRAIN_MASK =
  `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'>` +
  `<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='3' stitchTiles='stitch'/>` +
  `<feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.7 0'/></filter>` +
  `<rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")`;

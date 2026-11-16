let pixel: CanvasRenderingContext2D | null = null;

/** One 1×1 canvas, reused: theme changes resolve dozens of colors at once. */
function pixelContext(): CanvasRenderingContext2D | null {
  if (pixel) return pixel;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  pixel = canvas.getContext("2d", { willReadFrequently: true });
  return pixel;
}

export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

/**
 * Any CSS color (`oklch()`, named, translucent…) resolved to opaque RGB by
 * painting it on a 1×1 canvas — over `base` first when given, so a
 * translucent color is composited onto it. `null` where no canvas exists:
 * the caller keeps the raw value.
 */
export function cssColorToRgb(value: string, base?: string): RgbColor | null {
  if (typeof document === "undefined") return null;
  try {
    const context = pixelContext();
    if (!context) return null;
    context.clearRect(0, 0, 1, 1);
    // An invalid color leaves `fillStyle` unchanged: reset what the last call set.
    context.fillStyle = "#000000";
    if (base !== undefined) {
      context.fillStyle = base;
      context.fillRect(0, 0, 1, 1);
    }
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
    return { red, green, blue };
  } catch {
    // DOM shims without a canvas implementation throw: no color to resolve.
    return null;
  }
}

/** `cssColorToRgb` as `#rrggbb`. */
export function cssColorToHex(value: string, base?: string): string | null {
  const rgb = cssColorToRgb(value, base);
  if (!rgb) return null;
  const channels = [rgb.red, rgb.green, rgb.blue];
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

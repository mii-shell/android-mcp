import sharp from "sharp";
import { ToolError, adb } from "./adb.js";

/**
 * All coordinates exchanged with the agent are in "screen space": device pixels of the current
 * orientation, multiplied by `scale` so the long edge fits MAX_EDGE. Screenshots are delivered at
 * that size, and get_ui reports bounds in the same space, so coordinates can be used interchangeably.
 */
const MAX_EDGE = 1280;

export interface Display {
  width: number;
  height: number;
  scale: number;
}

const displays = new Map<string, Display>();

function remember(serial: string, width: number, height: number): Display {
  const display = { width, height, scale: Math.min(1, MAX_EDGE / Math.max(width, height)) };
  displays.set(serial, display);
  return display;
}

/** Called with the root bounds of every UI dump, which reflect the current orientation. */
export function observedDisplaySize(serial: string, width: number, height: number): Display {
  return remember(serial, width, height);
}

export async function display(serial: string): Promise<Display> {
  return displays.get(serial) ?? (await screenshot(serial)).display;
}

export function toDevice(d: Display, x: number, y: number): [number, number] {
  return [Math.round(x / d.scale), Math.round(y / d.scale)];
}

export function toScreen(d: Display, value: number): number {
  return Math.round(value * d.scale);
}

export async function screenshot(serial: string): Promise<{ png: Buffer; display: Display }> {
  const raw = await adb(serial, ["exec-out", "screencap", "-p"], { timeoutMs: 20_000 });
  const meta = await sharp(raw).metadata().catch(() => undefined);
  if (!meta?.width || !meta.height) throw new ToolError("screencap returned no image (is the screen on and unlocked?)");
  const d = remember(serial, meta.width, meta.height);
  const png =
    d.scale < 1
      ? await sharp(raw)
          .resize(toScreen(d, meta.width), toScreen(d, meta.height))
          .png({ compressionLevel: 9 })
          .toBuffer()
      : raw;
  return { png, display: d };
}

export function describeDisplay(d: Display): string {
  return `screen ${toScreen(d, d.width)}x${toScreen(d, d.height)} (device ${d.width}x${d.height}, scale ${d.scale.toFixed(3)})`;
}

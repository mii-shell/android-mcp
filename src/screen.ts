import sharp from "sharp";
import { ToolError, adb } from "./adb.js";

/**
 * All coordinates exchanged with the agent are in "screen space": device pixels of the current
 * orientation, multiplied by `scale` so the long edge fits MAX_EDGE. Screenshots are delivered at
 * that size, and get_ui reports bounds in the same space, so coordinates can be used interchangeably.
 * Image tokens grow with the pixel count, so the space is kept small; zoomed crops cover small text.
 */
const MAX_EDGE = 768;
const ZOOM_MAX_EDGE = 1024;

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

async function capture(serial: string): Promise<Buffer> {
  return adb(serial, ["exec-out", "screencap", "-p"], { timeoutMs: 20_000 });
}

export async function screenshot(serial: string): Promise<{ png: Buffer; display: Display }> {
  const raw = await capture(serial);
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

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A crop of the screen at up to ZOOM_MAX_EDGE px, for reading small text. Its pixels are not screen
 * coordinates; taps still use the coordinates of the full screenshot / get_ui.
 */
export async function zoomShot(serial: string, region: Region): Promise<{ png: Buffer; display: Display }> {
  const raw = await capture(serial);
  const meta = await sharp(raw).metadata();
  if (!meta.width || !meta.height) throw new ToolError("screencap returned no image (is the screen on and unlocked?)");
  const d = remember(serial, meta.width, meta.height);
  const [left, top] = toDevice(d, region.x, region.y);
  const [right, bottom] = toDevice(d, region.x + region.w, region.y + region.h);
  const x1 = Math.max(0, Math.min(left, meta.width - 1));
  const y1 = Math.max(0, Math.min(top, meta.height - 1));
  const width = Math.max(1, Math.min(right, meta.width) - x1);
  const height = Math.max(1, Math.min(bottom, meta.height) - y1);
  const factor = Math.min(1, ZOOM_MAX_EDGE / Math.max(width, height));
  const png = await sharp(raw)
    .extract({ left: x1, top: y1, width, height })
    .resize(Math.round(width * factor), Math.round(height * factor))
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { png, display: d };
}

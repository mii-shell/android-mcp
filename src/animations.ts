import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADB, shell } from "./adb.js";

/**
 * System animations are switched off while the server drives a device: steps get faster and the UI is
 * already settled when it is read. The original values are restored when the server exits. They are also
 * kept in a temp file, so a server that died without restoring doesn't make the next one treat 0 as original.
 *
 * Set ANDROID_MCP_KEEP_ANIMATIONS=1 to leave the animation settings alone.
 */
const SCALES = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"];

const keepAnimations = process.env.ANDROID_MCP_KEEP_ANIMATIONS === "1";
const prepared = new Set<string>();

function stateFile(serial: string): string {
  return join(tmpdir(), `android-mcp-animations-${serial.replace(/[^\w.-]/g, "_")}.json`);
}

export async function disableAnimations(serial: string): Promise<void> {
  if (keepAnimations || prepared.has(serial)) return;
  prepared.add(serial);
  const file = stateFile(serial);
  if (!existsSync(file)) {
    const values = (await shell(serial, SCALES.map((s) => `settings get global ${s}`).join("; "))).trim().split(/\s+/);
    writeFileSync(file, JSON.stringify(Object.fromEntries(SCALES.map((s, i) => [s, values[i] ?? "null"]))));
  }
  await shell(serial, SCALES.map((s) => `settings put global ${s} 0`).join("; "));
}

/** Synchronous, so it can run from the process "exit" handler. */
export function restoreAnimations(): void {
  for (const serial of prepared) {
    const file = stateFile(serial);
    try {
      const originals = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
      const commands = SCALES.map((s) =>
        // "null" means the setting was never set, i.e. the system default.
        !originals[s] || originals[s] === "null" ? `settings delete global ${s}` : `settings put global ${s} ${originals[s]}`,
      );
      spawnSync(ADB, ["-s", serial, "shell", commands.join("; ")], { timeout: 10_000, stdio: "ignore" });
      unlinkSync(file);
    } catch {
      // Device gone or state file missing: nothing we can restore.
    }
  }
  prepared.clear();
}

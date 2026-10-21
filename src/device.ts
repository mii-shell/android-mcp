import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMULATOR, ToolError, adbText, run, shell, sleep } from "./adb.js";

/** Stays below the usual 60 s MCP request timeout; calling start_emulator again keeps waiting. */
const BOOT_WAIT_MS = 40_000;
const BOOT_POLL_MS = 2_000;

export interface Device {
  serial: string;
  state: string;
  props: Record<string, string>;
}

export async function listDevices(): Promise<Device[]> {
  const out = await adbText(undefined, ["devices", "-l"]);
  return out
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const props = Object.fromEntries(
        rest.filter((kv) => kv.includes(":")).map((kv) => kv.split(":", 2) as [string, string]),
      );
      return { serial, state, props };
    });
}

export async function listAvds(): Promise<string[]> {
  try {
    const out = (await run(EMULATOR, ["-list-avds"])).toString("utf8");
    return out.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("INFO"));
  } catch {
    return [];
  }
}

export function describeDevice(d: Device): string {
  const kind = d.serial.startsWith("emulator-") ? "emulator" : "physical";
  const model = d.props.model ?? d.props.device ?? "?";
  return `${d.serial}  ${d.state}  ${kind}  model=${model}`;
}

export async function resolveSerial(serial?: string): Promise<string> {
  if (serial) return serial;
  const devices = await listDevices();
  const ready = devices.filter((d) => d.state === "device");
  if (ready.length === 1) return ready[0].serial;
  if (ready.length === 0) {
    const others = devices.length ? ` (not ready: ${devices.map(describeDevice).join("; ")})` : "";
    throw new ToolError(`No device connected${others}. Use list_devices / start_emulator.`);
  }
  throw new ToolError(
    `Several devices connected, pass "serial":\n${ready.map(describeDevice).join("\n")}`,
  );
}

async function emulatorAvdName(serial: string): Promise<string | undefined> {
  try {
    const out = await adbText(serial, ["emu", "avd", "name"], { timeoutMs: 5_000 });
    return out.split("\n")[0].trim();
  } catch {
    return undefined;
  }
}

async function findEmulator(avd: string): Promise<Device | undefined> {
  for (const d of await listDevices()) {
    if (d.serial.startsWith("emulator-") && (await emulatorAvdName(d.serial)) === avd) return d;
  }
  return undefined;
}

async function isBooted(serial: string): Promise<boolean> {
  try {
    return (await shell(serial, "getprop sys.boot_completed", { timeoutMs: 5_000 })).trim() === "1";
  } catch {
    return false;
  }
}

export async function startEmulator(avd: string, headless: boolean, coldBoot: boolean): Promise<string> {
  const running = await findEmulator(avd);
  if (running && (await isBooted(running.serial))) return `${avd} is already running as ${running.serial}.`;

  let exitedEarly: string | undefined;
  if (!running) {
    const avds = await listAvds();
    if (avds.length && !avds.includes(avd)) {
      throw new ToolError(`Unknown AVD "${avd}". Available: ${avds.join(", ")}`);
    }
    const args = ["-avd", avd];
    if (headless) args.push("-no-window", "-no-audio");
    if (coldBoot) args.push("-no-snapshot-load");
    const logPath = join(tmpdir(), `android-mcp-emulator-${avd}.log`);
    const log = openSync(logPath, "w");
    const child = spawn(EMULATOR, args, { detached: true, stdio: ["ignore", log, log] });
    closeSync(log);
    child.unref();
    child.on("exit", (code) => {
      exitedEarly = `exited with code ${code}. Log tail (${logPath}):\n` +
        readFileSync(logPath, "utf8").trim().split("\n").slice(-15).join("\n");
    });
  }

  const deadline = Date.now() + BOOT_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(BOOT_POLL_MS);
    if (exitedEarly) throw new ToolError(`Emulator ${exitedEarly}`);
    const device = await findEmulator(avd);
    if (device && device.state === "device" && (await isBooted(device.serial))) {
      return `${avd} booted as ${device.serial}.`;
    }
  }
  return `${avd} is still booting. Call start_emulator again with the same avd to keep waiting.`;
}

/** Physical (natural orientation) size from `wm size`, honouring an override size. */
export async function physicalSize(serial: string): Promise<{ width: number; height: number }> {
  const out = await shell(serial, "wm size");
  const matches = [...out.matchAll(/(\d+)x(\d+)/g)];
  const last = matches.at(-1);
  if (!last) throw new ToolError(`Unexpected "wm size" output: ${out.trim()}`);
  return { width: Number(last[1]), height: Number(last[2]) };
}

export async function density(serial: string): Promise<number | undefined> {
  const matches = [...(await shell(serial, "wm density")).matchAll(/(\d+)/g)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : undefined;
}

export async function setOrientation(serial: string, mode: "portrait" | "landscape" | "auto"): Promise<string> {
  if (mode === "auto") {
    await shell(serial, "settings put system accelerometer_rotation 1");
    return "Auto-rotation enabled.";
  }
  const { width, height } = await physicalSize(serial);
  const naturalPortrait = height >= width;
  const rotation = (mode === "portrait") === naturalPortrait ? 0 : 1;
  await shell(serial, `settings put system accelerometer_rotation 0 && settings put system user_rotation ${rotation}`);
  return `Orientation locked to ${mode} (user_rotation=${rotation}).`;
}

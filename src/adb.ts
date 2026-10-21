import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 128 * 1024 * 1024;

export class ToolError extends Error {}

function sdkRoots(): string[] {
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Android", "Sdk"),
    join(homedir(), "Library", "Android", "sdk"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk"),
  ].filter((p): p is string => !!p);
}

function sdkTool(subdir: string, name: string): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const root of sdkRoots()) {
    const candidate = join(root, subdir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return name; // fall back to PATH
}

export const ADB = sdkTool("platform-tools", "adb");
export const EMULATOR = sdkTool("emulator", "emulator");

export interface RunOptions {
  timeoutMs?: number;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "buffer", maxBuffer: MAX_BUFFER, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString().trim() || stdout.toString().trim() || error.message;
          const reason = error.killed ? `timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` : detail;
          reject(new ToolError(`${cmd} ${args.join(" ")}: ${reason}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function adb(serial: string | undefined, args: string[], opts?: RunOptions): Promise<Buffer> {
  return run(ADB, serial ? ["-s", serial, ...args] : args, opts);
}

export async function adbText(serial: string | undefined, args: string[], opts?: RunOptions): Promise<string> {
  return (await adb(serial, args, opts)).toString("utf8");
}

/** Runs a command line in the device shell. The string is interpreted by the device's `sh`. */
export function shell(serial: string, command: string, opts?: RunOptions): Promise<string> {
  return adbText(serial, ["shell", command], opts);
}

/** Quotes a value for the device shell. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

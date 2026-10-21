import { ToolError, adbText } from "./adb.js";
import { packageUid } from "./apps.js";

const DEFAULT_MAX_LINES = 200;
/** How far back a first call (or sinceLast=false) looks. */
const BACKLOG_LINES = 5_000;

const LEVELS = ["V", "D", "I", "W", "E", "F"] as const;
export type Level = (typeof LEVELS)[number];

/** Last line returned per device + filter, so the next call only shows what's new. */
const cursors = new Map<string, string>();

export interface LogcatOptions {
  pkg?: string;
  level?: Level;
  grep?: string;
  sinceLast: boolean;
  maxLines?: number;
}

export async function logcat(serial: string, opts: LogcatOptions): Promise<string> {
  const args = ["logcat", "-d", "-v", "threadtime", "-t", String(BACKLOG_LINES)];
  if (opts.pkg) {
    // Filtering by uid keeps the lines of earlier processes of the app too, e.g. the one that crashed.
    const uid = await packageUid(serial, opts.pkg);
    if (!uid) throw new ToolError(`Package ${opts.pkg} is not installed.`);
    args.push(`--uid=${uid}`);
  }
  args.push(`*:${opts.level ?? "V"}`);

  let lines = (await adbText(serial, args, { timeoutMs: 30_000 }))
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l && !l.startsWith("--------- beginning of"));

  const key = `${serial}|${opts.pkg ?? ""}|${opts.level ?? ""}|${opts.grep ?? ""}`;
  const cursor = cursors.get(key);
  if (opts.sinceLast && cursor) {
    const at = lines.lastIndexOf(cursor);
    if (at >= 0) lines = lines.slice(at + 1);
  }
  if (opts.grep) {
    let re: RegExp;
    try {
      re = new RegExp(opts.grep, "i");
    } catch (e) {
      throw new ToolError(`Invalid grep regex: ${(e as Error).message}`);
    }
    lines = lines.filter((l) => re.test(l));
  }
  if (lines.length) cursors.set(key, lines[lines.length - 1]);

  const max = opts.maxLines ?? DEFAULT_MAX_LINES;
  const dropped = Math.max(0, lines.length - max);
  const shown = lines.slice(-max);
  if (!shown.length) return cursor && opts.sinceLast ? "No new log lines since the last call." : "No log lines.";
  return (dropped ? `(${dropped} earlier lines omitted)\n` : "") + shown.join("\n");
}

export const LOG_LEVELS = LEVELS;

import { ToolError, shell } from "./adb.js";

/**
 * Crashes come from the system DropBox, which keeps a full report per crash (stack trace, process, version)
 * even after the process died and logcat rotated.
 */
const TAGS = {
  crash: "data_app_crash",
  anr: "data_app_anr",
  native: "data_app_native_crash",
} as const;

export type CrashType = keyof typeof TAGS;
export const CRASH_TYPES = Object.keys(TAGS) as CrashType[];

const SEPARATOR = /^={20,}$/m;
const ENTRY_HEADER = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\S+) \(/;

export interface Crash {
  id: string;
  type: CrashType;
  time: string;
  process: string;
  version: string;
  headline: string;
  location: string;
  body: string;
}

function headlineOf(type: CrashType, header: Record<string, string>, body: string): { headline: string; location: string } {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  if (type === "anr") return { headline: header.Subject ?? lines[0] ?? "ANR", location: "" };
  if (type === "native") {
    const signal = lines.find((l) => /^signal \d+/.test(l)) ?? "native crash";
    const abort = lines.find((l) => l.startsWith("Abort message:"));
    const frame = lines.find((l) => /^#00 pc /.test(l)) ?? "";
    return { headline: abort ? `${signal}; ${abort}` : signal, location: frame };
  }
  const location = lines.find((l) => l.startsWith("at "))?.slice(3) ?? "";
  return { headline: lines[0] ?? "crash", location };
}

function parseEntry(type: CrashType, text: string): Crash | undefined {
  const [first, ...rest] = text.replace(/^\n+/, "").split("\n");
  const m = first?.match(ENTRY_HEADER);
  if (!m) return undefined;
  const blank = rest.findIndex((l) => l.trim() === "");
  const headerLines = blank >= 0 ? rest.slice(0, blank) : rest;
  const header = Object.fromEntries(
    headerLines.map((l) => l.split(/:\s(.*)/s, 2)).filter((kv) => kv.length === 2) as [string, string][],
  );
  const body = (blank >= 0 ? rest.slice(blank + 1) : []).join("\n").trimEnd();
  const { headline, location } = headlineOf(type, header, body);
  return {
    id: `${type}@${m[1]}`,
    type,
    time: m[1],
    process: header.Process ?? "?",
    version: header.Package?.split(" ").slice(1).join(" ") ?? "",
    headline,
    location,
    body: [...headerLines, "", body].join("\n"),
  };
}

function belongsTo(crash: Crash, pkg: string): boolean {
  return crash.process === pkg || crash.process.startsWith(`${pkg}:`);
}

export async function readCrashes(serial: string, pkg: string, types: CrashType[]): Promise<Crash[]> {
  const crashes: Crash[] = [];
  for (const type of types) {
    const out = await shell(serial, `dumpsys dropbox --print ${TAGS[type]}`, { timeoutMs: 30_000 });
    for (const chunk of out.split(SEPARATOR).slice(1)) {
      const crash = parseEntry(type, chunk);
      if (crash && belongsTo(crash, pkg)) crashes.push(crash);
    }
  }
  return crashes.sort((a, b) => b.time.localeCompare(a.time));
}

export function formatCrashList(crashes: Crash[], total: number): string {
  if (!crashes.length) return "No crashes recorded.";
  const lines = crashes.map(
    (c) => `${c.id}  ${c.process} ${c.version}\n    ${c.headline}${c.location ? `\n    at ${c.location}` : ""}`,
  );
  const more = total > crashes.length ? `\n(${total - crashes.length} older not shown)` : "";
  return `${lines.join("\n")}${more}\nUse get_crash with an id for the full report.`;
}

export function formatCrash(crash: Crash, maxLines: number): string {
  const lines = crash.body.split("\n");
  const cut = lines.length > maxLines ? `\n… (${lines.length - maxLines} more lines, raise max_lines)` : "";
  return `${crash.id}\n${lines.slice(0, maxLines).join("\n")}${cut}`;
}

export function findCrash(crashes: Crash[], id: string): Crash {
  const crash = crashes.find((c) => c.id === id);
  if (!crash) throw new ToolError(`No crash ${id}. Use list_crashes for the available ids.`);
  return crash;
}

/** Device-local time `minutes` ago, in the DropBox timestamp format, for "since" filtering. */
export async function deviceTimeMinutesAgo(serial: string, minutes: number): Promise<string> {
  const epoch = Number((await shell(serial, "date +%s")).trim()) - minutes * 60;
  return (await shell(serial, `date -d @${epoch} '+%Y-%m-%d %H:%M:%S'`)).trim();
}

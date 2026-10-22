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

interface DeviceClock {
  /** Device epoch minus host epoch, in ms. */
  skewMs: number;
  /** Device time zone offset, in minutes east of UTC. */
  tzMinutes: number;
}

const clocks = new Map<string, DeviceClock>();

async function deviceClock(serial: string): Promise<DeviceClock> {
  const cached = clocks.get(serial);
  if (cached) return cached;
  const before = Date.now();
  const out = (await shell(serial, "date +%s%z")).trim();
  const after = Date.now();
  const m = out.match(/^(\d+)([+-])(\d{2})(\d{2})$/);
  if (!m) throw new ToolError(`Unexpected device date output: ${out}`);
  const clock = {
    skewMs: Number(m[1]) * 1000 - (before + after) / 2,
    tzMinutes: (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4])),
  };
  clocks.set(serial, clock);
  return clock;
}

/** The device's local wall-clock time `msAgo` before now, in the DropBox timestamp format. */
async function deviceTime(serial: string, msAgo: number): Promise<string> {
  const clock = await deviceClock(serial);
  const local = new Date(Date.now() - msAgo + clock.skewMs + clock.tzMinutes * 60_000);
  return local.toISOString().slice(0, 19).replace("T", " ");
}

interface Watch {
  since: string;
  reported: Set<string>;
}

/** Per device + package: from when crashes count as new, and which were already reported. */
const watches = new Map<string, Watch>();

/** Starts watching a package for crashes, if not already watched. Cheap after the first call. */
export async function watchCrashes(serial: string, pkg: string): Promise<void> {
  const key = `${serial}|${pkg}`;
  if (!watches.has(key)) watches.set(key, { since: await deviceTime(serial, 1_000), reported: new Set() });
}

/**
 * New crashes of `pkg` since the watch started, each reported once. Lists DropBox headers first (~75 ms)
 * and reads full reports only when a matching entry appeared.
 */
export async function newCrashNotice(serial: string, pkg: string): Promise<string | undefined> {
  const watch = watches.get(`${serial}|${pkg}`);
  if (!watch) return undefined;
  const headers = await shell(serial, `dumpsys dropbox | grep -E '^[0-9-]+ [0-9:]+ (${Object.values(TAGS).join("|")}) '`).catch(
    () => "",
  );
  const types = new Set<CrashType>();
  for (const line of headers.split("\n")) {
    const m = line.match(ENTRY_HEADER);
    if (!m || m[1] < watch.since) continue;
    const type = CRASH_TYPES.find((t) => TAGS[t] === m[2]);
    if (type && !watch.reported.has(`${type}@${m[1]}`)) types.add(type);
  }
  if (!types.size) return undefined;
  const fresh = (await readCrashes(serial, pkg, [...types])).filter((c) => c.time >= watch.since && !watch.reported.has(c.id));
  if (!fresh.length) return undefined;
  for (const c of fresh) watch.reported.add(c.id);
  const what = (c: Crash) => ({ crash: "crashed", anr: "stopped responding (ANR)", native: "crashed (native)" })[c.type];
  return fresh
    .map((c) => `⚠ ${pkg} ${what(c)} at ${c.time}: ${c.headline}${c.location ? `\n    at ${c.location}` : ""}\n    get_crash id: ${c.id}`)
    .join("\n");
}

export function watchedPackages(serial: string): string[] {
  return [...watches.keys()].filter((k) => k.startsWith(`${serial}|`)).map((k) => k.slice(serial.length + 1));
}

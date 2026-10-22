import { ToolError, shell } from "./adb.js";
import { checkPackage, currentApp } from "./apps.js";

/**
 * The server only drives apps that Android Studio installed with "Run": debuggable, marked testOnly (Studio
 * injects `android:testOnly` for IDE builds, and only `adb install -t` accepts such APKs) and, where Android
 * records it (API 30+), installed by the shell, i.e. over adb.
 */
const CACHE_TTL_MS = 30_000;

/** System dialogs an allowed app may bring up, such as runtime permission prompts. */
const SYSTEM_DIALOG_PACKAGES = new Set(["com.google.android.permissioncontroller", "com.android.permissioncontroller"]);

export const POLICY_DESCRIPTION =
  "Only debug builds installed from Android Studio (Run) are allowed: debuggable + testOnly + installed via adb.";

interface Verdict {
  allowed: boolean;
  reason: string;
  checkedAt: number;
}

const verdicts = new Map<string, Verdict>();

function judge(dump: string): Omit<Verdict, "checkedAt"> {
  if (!/^\s*pkgFlags=/m.test(dump)) return { allowed: false, reason: "not installed" };
  const flags = dump.match(/^\s*pkgFlags=\[([^\]]*)\]/m)?.[1].split(/\s+/) ?? [];
  const initiator = dump.match(/^\s*initiatingPackageName=(\S+)/m)?.[1];
  if (!flags.includes("DEBUGGABLE")) return { allowed: false, reason: "not a debuggable build" };
  if (!flags.includes("TEST_ONLY")) return { allowed: false, reason: "not testOnly (not installed via Android Studio Run)" };
  if (initiator && initiator !== "com.android.shell") return { allowed: false, reason: `installed by ${initiator}, not adb` };
  return { allowed: true, reason: "Android Studio dev build" };
}

export async function devAppVerdict(serial: string, pkg: string): Promise<Verdict> {
  checkPackage(pkg);
  const key = `${serial}|${pkg}`;
  const cached = verdicts.get(key);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached;
  const dump = await shell(serial, `dumpsys package ${pkg} | grep -E '^ *(pkgFlags|initiatingPackageName)='`);
  const verdict = { ...judge(dump), checkedAt: Date.now() };
  verdicts.set(key, verdict);
  return verdict;
}

export async function assertDevApp(serial: string, pkg: string): Promise<void> {
  const verdict = await devAppVerdict(serial, pkg);
  if (!verdict.allowed) throw new ToolError(`${pkg} is not allowed: ${verdict.reason}. ${POLICY_DESCRIPTION}`);
}

export async function listDevApps(serial: string): Promise<string[]> {
  const out = await shell(
    serial,
    "for p in $(pm list packages -3 | cut -d: -f2); do " +
      "echo \"== $p\"; dumpsys package $p | grep -E '^ *(pkgFlags|initiatingPackageName)='; done",
    { timeoutMs: 60_000 },
  );
  const allowed: string[] = [];
  for (const block of out.split(/^== /m).slice(1)) {
    const [pkg, ...rest] = block.split("\n");
    const verdict = { ...judge(rest.join("\n")), checkedAt: Date.now() };
    verdicts.set(`${serial}|${pkg.trim()}`, verdict);
    if (verdict.allowed) allowed.push(pkg.trim());
  }
  return allowed.sort();
}

/** Returns why the foreground may not be used, or undefined when it may. */
export async function foregroundProblem(
  serial: string,
  app?: { pkg: string; activity: string },
): Promise<string | undefined> {
  app ??= await currentApp(serial);
  if (!app) return "Could not determine the app in the foreground.";
  if (SYSTEM_DIALOG_PACKAGES.has(app.pkg)) return undefined;
  const verdict = await devAppVerdict(serial, app.pkg);
  if (verdict.allowed) return undefined;
  return (
    `The foreground app is ${app.pkg} (${verdict.reason}). ${POLICY_DESCRIPTION} ` +
    "Use list_dev_apps and launch_app to bring one to the front."
  );
}

/** Returns the allowed dev app in the foreground (undefined while a system permission dialog is shown). */
export async function assertForegroundAllowed(serial: string): Promise<string | undefined> {
  const app = await currentApp(serial);
  const problem = await foregroundProblem(serial, app);
  if (problem) throw new ToolError(problem);
  return app && !SYSTEM_DIALOG_PACKAGES.has(app.pkg) ? app.pkg : undefined;
}

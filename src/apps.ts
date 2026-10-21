import { ToolError, shQuote, shell } from "./adb.js";

const PACKAGE_RE = /^[A-Za-z0-9_.]+$/;

export function checkPackage(pkg: string): string {
  if (!PACKAGE_RE.test(pkg)) throw new ToolError(`Invalid package name "${pkg}".`);
  return pkg;
}

export async function currentApp(serial: string): Promise<{ pkg: string; activity: string } | undefined> {
  const out = await shell(serial, "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity|ResumedActivity:'");
  const m = out.match(/\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/);
  return m ? { pkg: m[1], activity: m[2] } : undefined;
}

export async function launchApp(serial: string, pkg: string, activity?: string): Promise<string> {
  checkPackage(pkg);
  if (activity) {
    const component = activity.includes("/") ? activity : `${pkg}/${activity}`;
    const out = await shell(serial, `am start -W -n ${shQuote(component)}`, { timeoutMs: 60_000 });
    if (/Error|Exception/.test(out)) throw new ToolError(out.trim());
    return `Started ${component}.`;
  }
  const out = await shell(serial, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeoutMs: 60_000 });
  if (/No activities found|monkey aborted/i.test(out)) throw new ToolError(`No launcher activity for ${pkg} (installed?).`);
  return `Launched ${pkg}.`;
}

export async function stopApp(serial: string, pkg: string): Promise<string> {
  await shell(serial, `am force-stop ${checkPackage(pkg)}`);
  return `Stopped ${pkg}.`;
}

export async function clearAppData(serial: string, pkg: string): Promise<string> {
  const out = await shell(serial, `pm clear ${checkPackage(pkg)}`);
  if (!/Success/.test(out)) throw new ToolError(`pm clear failed: ${out.trim()}`);
  return `Cleared data of ${pkg}.`;
}

export async function openUrl(serial: string, url: string, pkg?: string): Promise<string> {
  const target = pkg ? ` -p ${checkPackage(pkg)}` : "";
  const out = await shell(serial, `am start -W -a android.intent.action.VIEW -d ${shQuote(url)}${target}`, {
    timeoutMs: 60_000,
  });
  if (/Error|Exception/.test(out)) throw new ToolError(out.trim());
  return `Opened ${url}.`;
}

export async function packageUid(serial: string, pkg: string): Promise<string | undefined> {
  const out = await shell(serial, `pm list packages -U ${checkPackage(pkg)}`);
  const line = out.split("\n").find((l) => l.trim().startsWith(`package:${pkg} `));
  return line?.match(/uid:(\d+)/)?.[1];
}

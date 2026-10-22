import { type ChildProcess, spawn } from "node:child_process";
import { SERVER_APK_PATH, TEST_APK_PATH, version as SERVER_VERSION } from "appium-uiautomator2-server";
import { ADB, adbText, shell, sleep } from "./adb.js";

/**
 * Resident on-device agent: Appium's UiAutomator2 server (Apache-2.0), driven over its HTTP API. It keeps
 * the accessibility connection open, so reading the UI tree takes a few hundred ms instead of the 2-3 s of
 * a fresh `uiautomator dump`, and it does not wait for the screen to become idle.
 *
 * Set ANDROID_MCP_AGENT=0 to fall back to `uiautomator dump`.
 */
const SERVER_PACKAGE = "io.appium.uiautomator2.server";
const TEST_PACKAGE = "io.appium.uiautomator2.server.test";
const INSTRUMENTATION = `${TEST_PACKAGE}/androidx.test.runner.AndroidJUnitRunner`;
const DEVICE_PORT = 6790;
const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** A device where the agent can't be started is not retried for a while; dumps are used meanwhile. */
const RETRY_AFTER_MS = 60_000;

const SESSION_SETTINGS = {
  waitForIdleTimeout: 0,
  waitForSelectorTimeout: 0,
  // Exposes Compose test tags as resource ids, so they can be targeted with `id`.
  mapTestTagToResourceId: true,
};

interface Agent {
  base: string;
  sessionId: string;
}

const agents = new Map<string, Agent>();
const failures = new Map<string, number>();
const instrumentations = new Map<string, ChildProcess>();

export const agentEnabled = process.env.ANDROID_MCP_AGENT !== "0";

process.on("exit", () => {
  for (const child of instrumentations.values()) child.kill();
});

async function request(base: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = (await response.json()) as { value?: unknown };
  if (!response.ok) {
    const error = json.value as { message?: string } | undefined;
    throw new Error(`${method} ${path}: HTTP ${response.status} ${error?.message ?? ""}`.trim());
  }
  return json.value;
}

async function installedVersion(serial: string, pkg: string): Promise<string | undefined> {
  const out = await shell(serial, `dumpsys package ${pkg} | grep -m1 versionName=`);
  return out.match(/versionName=(\S+)/)?.[1];
}

async function ensureInstalled(serial: string): Promise<void> {
  const [server, test] = await Promise.all([
    installedVersion(serial, SERVER_PACKAGE),
    shell(serial, `pm path ${TEST_PACKAGE}`).catch(() => ""),
  ]);
  if (server === SERVER_VERSION && test.includes("package:")) return;
  for (const apk of [SERVER_APK_PATH, TEST_APK_PATH]) {
    const out = await adbText(serial, ["install", "-r", "-g", apk], { timeoutMs: 120_000 });
    if (!/Success/.test(out)) throw new Error(`Installing ${apk} failed: ${out.trim()}`);
  }
}

async function forwardedBase(serial: string): Promise<string> {
  const list = await adbText(undefined, ["forward", "--list"]);
  const existing = list
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([s, local, remote]) => s === serial && remote === `tcp:${DEVICE_PORT}` && local?.startsWith("tcp:"));
  const port = existing ? existing[1].slice(4) : (await adbText(serial, ["forward", "tcp:0", `tcp:${DEVICE_PORT}`])).trim();
  return `http://127.0.0.1:${port}`;
}

async function isReady(base: string): Promise<boolean> {
  try {
    const status = (await request(base, "GET", "/status")) as { ready?: boolean };
    return status?.ready === true;
  } catch {
    return false;
  }
}

async function start(serial: string): Promise<Agent> {
  await ensureInstalled(serial);
  const base = await forwardedBase(serial);
  if (!(await isReady(base))) {
    instrumentations.get(serial)?.kill();
    const child = spawn(
      ADB,
      ["-s", serial, "shell", "am", "instrument", "-w", "-e", "disableAnalytics", "true", INSTRUMENTATION],
      { stdio: "ignore" },
    );
    child.on("exit", () => {
      if (instrumentations.get(serial) === child) instrumentations.delete(serial);
      agents.delete(serial);
    });
    instrumentations.set(serial, child);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!(await isReady(base))) {
      if (Date.now() > deadline) throw new Error(`UiAutomator2 server did not start within ${START_TIMEOUT_MS / 1000} s`);
      await sleep(300);
    }
  }
  const session = (await request(base, "POST", "/session", {
    capabilities: { firstMatch: [{}], alwaysMatch: { platformName: "Android" } },
  })) as { sessionId: string };
  await request(base, "POST", `/session/${session.sessionId}/appium/settings`, { settings: SESSION_SETTINGS });
  return { base, sessionId: session.sessionId };
}

async function agentFor(serial: string): Promise<Agent | undefined> {
  const existing = agents.get(serial);
  if (existing) return existing;
  const failedAt = failures.get(serial);
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return undefined;
  try {
    const agent = await start(serial);
    agents.set(serial, agent);
    failures.delete(serial);
    released.delete(serial);
    return agent;
  } catch (e) {
    console.error(`android-mcp: agent unavailable on ${serial}, using uiautomator dump: ${(e as Error).message}`);
    failures.set(serial, Date.now());
    return undefined;
  }
}

/** The UI hierarchy XML from the agent, or undefined when the agent can't be used (callers fall back to a dump). */
export async function agentSource(serial: string): Promise<string | undefined> {
  if (!agentEnabled) return undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const agent = await agentFor(serial);
    if (!agent) return undefined;
    try {
      return (await request(agent.base, "GET", `/session/${agent.sessionId}/source`)) as string;
    } catch {
      // Server restarted or session lost (e.g. the device rebooted): start over once.
      agents.delete(serial);
    }
  }
  return undefined;
}

const released = new Set<string>();

/**
 * Only one process can hold the UiAutomation connection, so a still running server (e.g. from an earlier
 * session) makes `uiautomator dump` fail. Stops it once before the first dump on a device.
 */
export async function releaseForDump(serial: string): Promise<void> {
  if (released.has(serial) || agents.has(serial)) return;
  released.add(serial);
  instrumentations.get(serial)?.kill();
  await shell(serial, `am force-stop ${TEST_PACKAGE}; am force-stop ${SERVER_PACKAGE}`).catch(() => undefined);
}

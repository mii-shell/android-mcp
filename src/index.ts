#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ToolError, sleep } from "./adb.js";
import * as apps from "./apps.js";
import * as device from "./device.js";
import * as input from "./input.js";
import { disableAnimations, restoreAnimations } from "./animations.js";
import {
  CRASH_TYPES,
  deviceTimeMinutesAgo,
  findCrash,
  formatCrash,
  formatCrashList,
  newCrashNotice,
  readCrashes,
  watchCrashes,
  watchedPackages,
} from "./crashes.js";
import { LOG_LEVELS, logcat } from "./logcat.js";
import { POLICY_DESCRIPTION, assertDevApp, assertForegroundAllowed, devAppVerdict, foregroundProblem, listDevApps } from "./policy.js";
import { withDevice } from "./queue.js";
import { describeDisplay, display, screenshot, toDevice, zoomShot } from "./screen.js";
import {
  type Element,
  contentLabels,
  dumpTree,
  findByRef,
  findElements,
  formatChanges,
  formatTree,
} from "./uitree.js";

const DEFAULT_SETTLE_MS = 300;
const WAIT_POLL_MS = 400;
const FOCUS_WAIT_MS = 3_000;

type Content = CallToolResult["content"];

const server = new McpServer(
  { name: "android", version: "0.1.0" },
  {
    instructions:
      "Drive Android apps on local emulators/devices like a human: observe with get_ui (accessibility tree) " +
      "or screenshot, act with tap/swipe/type_text/press_key, wait with wait_for, check logcat for crashes. " +
      "All x/y coordinates are screen coordinates as shown in screenshots and get_ui (not raw device pixels). " +
      "Action tools report what changed on screen (observe=changes by default); element [ref] numbers stay valid " +
      "across calls. Prefer tap by text/id/index; use x/y from a screenshot only for things missing from the tree " +
      "(maps, canvases, games, video). Screenshots cost far more tokens than the tree: request them only when the " +
      "tree is not enough. To read a long list or form, use read_all instead of scrolling step by step. " +
      `${POLICY_DESCRIPTION} Screen tools refuse to work while any other app is in the foreground; ` +
      "start with list_dev_apps and launch_app.",
  },
);

const SERIAL = {
  serial: z.string().optional().describe("adb serial; optional when exactly one device is connected"),
};

const OBSERVE_MODES = ["none", "changes", "ui", "screenshot", "both"] as const;
type ObserveMode = (typeof OBSERVE_MODES)[number];

const OBSERVE = {
  observe: z
    .enum(OBSERVE_MODES)
    .default("changes")
    .describe(
      "What to return after the action: changes (default: only what changed since you last saw the screen, " +
        "full tree on a new screen), ui (full tree), screenshot, both (tree + screenshot), none",
    ),
  settle_ms: z.number().int().min(0).max(10_000).default(DEFAULT_SETTLE_MS).describe("Wait before observing"),
};

const TARGET = {
  index: z.number().int().optional().describe("Element [ref] from get_ui or a change report"),
  text: z.string().optional().describe("Match element text or content description (case-insensitive)"),
  id: z.string().optional().describe("Match resource id / Compose testTag"),
  exact: z.boolean().default(false).describe("Require the whole text/id to match instead of a substring"),
  occurrence: z.number().int().min(0).default(0).describe("Which match to use when several match (0-based)"),
  x: z.number().optional().describe("Screen x (with y), from a screenshot or get_ui"),
  y: z.number().optional(),
};

type TargetArgs = {
  index?: number;
  text?: string;
  id?: string;
  exact: boolean;
  occurrence: number;
  x?: number;
  y?: number;
};

const text = (t: string): Content => [{ type: "text", text: t }];

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<Content>,
) {
  server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>) => {
    try {
      return { content: await handler(args) };
    } catch (e) {
      const message = e instanceof ToolError ? e.message : `Unexpected error: ${(e as Error).stack ?? e}`;
      return { isError: true, content: text(message) };
    }
  }) as never);
}

/** Resolves the device and runs `fn` in that device's queue. */
function onDevice<A extends { serial?: string }>(fn: (serial: string, args: A) => Promise<Content>) {
  return async (args: A) => {
    const serial = await device.resolveSerial(args.serial);
    return withDevice(serial, () => fn(serial, args));
  };
}

/** Like onDevice, but refuses to run unless an allowed dev app is in the foreground. */
function inDevApp<A extends { serial?: string }>(fn: (serial: string, args: A) => Promise<Content>) {
  return onDevice<A>(async (serial, args) => {
    let pkg: string | undefined;
    try {
      pkg = await assertForegroundAllowed(serial);
    } catch (e) {
      // The app may have left the foreground because it crashed since the last call: say so.
      const notices = await Promise.all(watchedPackages(serial).map((p) => newCrashNotice(serial, p).catch(() => undefined)));
      const notice = notices.filter(Boolean).join("\n");
      if (notice && e instanceof ToolError) throw new ToolError(`${notice}\n${e.message}`);
      throw e;
    }
    await disableAnimations(serial);
    return withCrashWatch(serial, pkg, () => fn(serial, args));
  });
}

/** Runs an action and puts a notice in front of its result (or error) when the app crashed meanwhile. */
async function withCrashWatch(serial: string, pkg: string | undefined, run: () => Promise<Content>): Promise<Content> {
  if (!pkg) return run();
  await watchCrashes(serial, pkg);
  try {
    const out = await run();
    const notice = await newCrashNotice(serial, pkg);
    return notice ? [...text(notice), ...out] : out;
  } catch (e) {
    const notice = await newCrashNotice(serial, pkg).catch(() => undefined);
    if (notice && e instanceof ToolError) throw new ToolError(`${notice}\n${e.message}`);
    throw e;
  }
}

async function observe(serial: string, mode: ObserveMode, settleMs: number): Promise<Content> {
  // Settle even without observing, so the next action doesn't hit a UI that is still transitioning.
  await sleep(settleMs);
  if (mode === "none") return [];
  const problem = await foregroundProblem(serial);
  if (problem) return text(`Not showing the screen: ${problem}`);
  const out: Content = [];
  if (mode !== "screenshot") {
    try {
      const tree = await dumpTree(serial);
      out.push({ type: "text", text: mode === "changes" ? formatChanges(tree) : formatTree(tree, false) });
    } catch (e) {
      out.push({ type: "text", text: e instanceof ToolError ? e.message : String(e) });
      // Without a tree the agent needs pixels to continue.
      if (mode !== "both") mode = "screenshot";
    }
  }
  if (mode === "screenshot" || mode === "both") {
    const shot = await screenshot(serial);
    out.push({ type: "image", data: shot.png.toString("base64"), mimeType: "image/png" });
  }
  return out;
}

function describeElement(e: Element): string {
  const label = e.text || e.desc || e.childText || e.id;
  return `[${e.ref}] ${e.cls}${label ? ` "${label}"` : ""}`;
}

/** Returns the device-pixel point for a target plus a short description of it. */
async function resolveTarget(serial: string, t: TargetArgs): Promise<{ x: number; y: number; label: string; element?: Element }> {
  const kinds = [t.index !== undefined, t.text !== undefined, t.id !== undefined, t.x !== undefined || t.y !== undefined];
  if (kinds.filter(Boolean).length !== 1) throw new ToolError("Give exactly one target: index, text, id, or x+y.");

  if (t.x !== undefined || t.y !== undefined) {
    if (t.x === undefined || t.y === undefined) throw new ToolError("x and y must be given together.");
    const d = await display(serial);
    const [x, y] = toDevice(d, t.x, t.y);
    return { x, y, label: `(${t.x},${t.y})` };
  }

  let element: Element | undefined;
  if (t.index !== undefined) {
    element = findByRef(await dumpTree(serial), t.index);
    if (!element) throw new ToolError(`Element [${t.index}] is no longer on screen; call get_ui.`);
  } else {
    const tree = await dumpTree(serial);
    const found = findElements(tree, { text: t.text, id: t.id, exact: t.exact });
    if (!found.length) {
      throw new ToolError(`No element matching ${t.text !== undefined ? `text "${t.text}"` : `id "${t.id}"`}.`);
    }
    element = found[t.occurrence];
    if (!element) throw new ToolError(`Only ${found.length} matches, occurrence ${t.occurrence} is out of range.`);
    if (found.length > 1) {
      const others = found.map(describeElement).join(", ");
      return { ...centre(element), label: `${describeElement(element)} (${found.length} matches: ${others})`, element };
    }
  }
  return { ...centre(element), label: describeElement(element), element };
}

/** Keystrokes sent while a field is still opening get lost, so wait until one has focus. */
async function waitForFocusedField(serial: string): Promise<boolean> {
  const deadline = Date.now() + FOCUS_WAIT_MS;
  do {
    try {
      if ((await dumpTree(serial)).elements.some((e) => e.editable && e.focused)) return true;
    } catch {
      return false; // no tree (e.g. a busy GL screen): nothing to wait on
    }
    await sleep(WAIT_POLL_MS);
  } while (Date.now() < deadline);
  return false;
}

/** Default scroll target; swiping the screen centre instead could hit a scrim and dismiss a panel. */
function largestScrollable(elements: Element[]): Element | undefined {
  const area = (e: Element) => (e.bounds.x2 - e.bounds.x1) * (e.bounds.y2 - e.bounds.y1);
  return elements.filter((e) => e.scrollable && area(e) > 0).sort((a, b) => area(b) - area(a))[0];
}

async function screenArea(serial: string): Promise<Element["bounds"]> {
  const d = await display(serial);
  return { x1: 0, y1: Math.round(d.height * 0.15), x2: d.width, y2: Math.round(d.height * 0.85) };
}

function centre(e: Element) {
  return { x: Math.round((e.bounds.x1 + e.bounds.x2) / 2), y: Math.round((e.bounds.y1 + e.bounds.y2) / 2) };
}

// ---- Devices -----------------------------------------------------------------------------------

tool("list_devices", "List connected adb devices (emulators and physical) and available AVDs.", {}, async () => {
  const [devices, avds] = await Promise.all([device.listDevices(), device.listAvds()]);
  return text(
    [
      "Devices:",
      ...(devices.length ? devices.map((d) => `  ${device.describeDevice(d)}`) : ["  (none)"]),
      "AVDs:",
      ...(avds.length ? avds.map((a) => `  ${a}`) : ["  (none found)"]),
    ].join("\n"),
  );
});

tool(
  "start_emulator",
  "Start an Android emulator (AVD) and wait until it has booted. Returns immediately if it is already running.",
  {
    avd: z.string().describe("AVD name from list_devices"),
    headless: z.boolean().default(false).describe("Run without a window"),
    cold_boot: z.boolean().default(false).describe("Ignore the quick-boot snapshot"),
  },
  async ({ avd, headless, cold_boot }) => text(await device.startEmulator(avd, headless, cold_boot)),
);

tool(
  "get_screen_info",
  "Screen size, density, coordinate scale and the app in the foreground.",
  { ...SERIAL },
  onDevice(async (serial) => {
    const [physical, dpi, app] = await Promise.all([
      device.physicalSize(serial),
      device.density(serial),
      apps.currentApp(serial),
    ]);
    const d = (await screenshot(serial)).display;
    return text(
      [
        describeDisplay(d),
        `physical ${physical.width}x${physical.height}, density ${dpi ?? "?"} dpi`,
        `foreground: ${app ? `${app.pkg}/${app.activity}` : "?"}`,
      ].join("\n"),
    );
  }),
);

tool(
  "set_orientation",
  "Lock the screen to portrait or landscape, or re-enable auto-rotation.",
  { ...SERIAL, orientation: z.enum(["portrait", "landscape", "auto"]), ...OBSERVE },
  onDevice(async (serial, a) => [
    ...text(await device.setOrientation(serial, a.orientation)),
    ...(await observe(serial, a.observe, Math.max(a.settle_ms, 1000))),
  ]),
);

// ---- Apps --------------------------------------------------------------------------------------

tool(
  "list_dev_apps",
  `List the apps this server may use. ${POLICY_DESCRIPTION}`,
  { ...SERIAL },
  onDevice(async (serial) => {
    const pkgs = await listDevApps(serial);
    return text(pkgs.length ? pkgs.join("\n") : "No Android Studio dev builds installed. Install one with Run in Android Studio.");
  }),
);

tool(
  "current_app",
  "Package and activity currently in the foreground.",
  { ...SERIAL },
  onDevice(async (serial) => {
    const app = await apps.currentApp(serial);
    if (!app) return text("Could not determine the foreground activity.");
    const verdict = await devAppVerdict(serial, app.pkg);
    return text(`${app.pkg}/${app.activity} (${verdict.allowed ? "allowed" : `not allowed: ${verdict.reason}`})`);
  }),
);

tool(
  "launch_app",
  "Launch an allowed dev app by package (its launcher activity), or a specific activity of it.",
  {
    ...SERIAL,
    package: z.string(),
    activity: z.string().optional().describe("e.g. .MainActivity or com.foo/.MainActivity"),
    ...OBSERVE,
  },
  onDevice(async (serial, a) => {
    await assertDevApp(serial, a.package);
    if (a.activity?.includes("/") && !a.activity.startsWith(`${a.package}/`)) {
      throw new ToolError(`Activity ${a.activity} does not belong to ${a.package}.`);
    }
    await disableAnimations(serial);
    return withCrashWatch(serial, a.package, async () => [
      ...text(await apps.launchApp(serial, a.package, a.activity)),
      ...(await observe(serial, a.observe, Math.max(a.settle_ms, 1500))),
    ]);
  }),
);

tool(
  "stop_app",
  "Force-stop an app.",
  { ...SERIAL, package: z.string() },
  onDevice(async (serial, a) => {
    await assertDevApp(serial, a.package);
    return text(await apps.stopApp(serial, a.package));
  }),
);

tool(
  "clear_app_data",
  "Delete all data of an app (like a fresh install). Also stops it.",
  { ...SERIAL, package: z.string() },
  onDevice(async (serial, a) => {
    await assertDevApp(serial, a.package);
    return text(await apps.clearAppData(serial, a.package));
  }),
);

tool(
  "open_url",
  "Open a URL / deep link in an allowed dev app with an ACTION_VIEW intent.",
  { ...SERIAL, url: z.string(), package: z.string().describe("The dev app that should handle the link"), ...OBSERVE },
  onDevice(async (serial, a) => {
    await assertDevApp(serial, a.package);
    await disableAnimations(serial);
    return withCrashWatch(serial, a.package, async () => [
      ...text(await apps.openUrl(serial, a.url, a.package)),
      ...(await observe(serial, a.observe, Math.max(a.settle_ms, 1000))),
    ]);
  }),
);

// ---- Observe -----------------------------------------------------------------------------------

tool(
  "screenshot",
  "Take a screenshot (costs far more tokens than get_ui; use it for visuals the tree lacks). Its pixel " +
    "coordinates are the screen coordinates every other tool uses. With region, returns a sharper crop for " +
    "reading small text; a crop's pixels are NOT screen coordinates.",
  {
    ...SERIAL,
    region: z
      .object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() })
      .optional()
      .describe("Screen-coordinate rectangle to zoom into"),
  },
  inDevApp(async (serial, a) => {
    if (a.region) {
      const crop = await zoomShot(serial, a.region);
      return [
        { type: "image", data: crop.png.toString("base64"), mimeType: "image/png" },
        ...text(`Zoomed crop of (${a.region.x},${a.region.y}) ${a.region.w}x${a.region.h}; use screen coordinates to tap.`),
      ];
    }
    const shot = await screenshot(serial);
    return [
      { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
      ...text(describeDisplay(shot.display)),
    ];
  }),
);

tool(
  "get_ui",
  "The visible UI as a list of elements: [ref] (stable across calls), text, desc, id, centre, size, flags. " +
    "Target elements by ref (index), text or id. Falls back to a screenshot when no tree is available.",
  { ...SERIAL, all: z.boolean().default(false).describe("Include layout-only nodes") },
  inDevApp(async (serial, a) => {
    try {
      return text(formatTree(await dumpTree(serial), a.all));
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      const shot = await screenshot(serial);
      return [
        ...text(`${e.message}\n${describeDisplay(shot.display)}`),
        { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
      ];
    }
  }),
);

tool(
  "wait_for",
  "Wait until an element with the given text/id appears (or, with gone=true, disappears).",
  {
    ...SERIAL,
    text: z.string().optional(),
    id: z.string().optional(),
    exact: z.boolean().default(false),
    gone: z.boolean().default(false),
    timeout_ms: z.number().int().min(0).max(120_000).default(10_000),
    observe: z.enum(OBSERVE_MODES).default("changes"),
  },
  inDevApp(async (serial, a) => {
    if ((a.text === undefined) === (a.id === undefined)) throw new ToolError("Give exactly one of text or id.");
    const what = a.text !== undefined ? `text "${a.text}"` : `id "${a.id}"`;
    const deadline = Date.now() + a.timeout_ms;
    let lastError = "";
    do {
      await assertForegroundAllowed(serial);
      try {
        const found = findElements(await dumpTree(serial), { text: a.text, id: a.id, exact: a.exact }).length > 0;
        if (found !== a.gone) {
          return [...text(`${what} ${a.gone ? "is gone" : "is visible"}.`), ...(await observe(serial, a.observe, 0))];
        }
        lastError = "";
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        lastError = e.message;
      }
      await sleep(WAIT_POLL_MS);
    } while (Date.now() < deadline);
    throw new ToolError(
      `Timed out after ${a.timeout_ms} ms waiting for ${what} to ${a.gone ? "disappear" : "appear"}.` +
        (lastError ? ` Last error: ${lastError}` : ""),
    );
  }),
);

tool(
  "logcat",
  "Read the log of an allowed dev app (including lines of crashed earlier processes). " +
    "By default returns only lines that are new since the previous call with the same filters.",
  {
    ...SERIAL,
    package: z.string(),
    level: z.enum(LOG_LEVELS).optional().describe("Minimum priority: V D I W E F"),
    grep: z.string().optional().describe("Case-insensitive regex applied to each line"),
    since_last: z.boolean().default(true),
    max_lines: z.number().int().min(1).max(2_000).default(200),
  },
  onDevice(async (serial, a) => {
    await assertDevApp(serial, a.package);
    return text(
      await logcat(serial, {
        pkg: a.package,
        level: a.level,
        grep: a.grep,
        sinceLast: a.since_last,
        maxLines: a.max_lines,
      }),
    );
  }),
);

tool(
  "list_crashes",
  "List recorded crashes, ANRs and native crashes of a dev app, newest first, with exception and top frame. " +
    "Reports survive the process and logcat rotation.",
  {
    ...SERIAL,
    package: z.string(),
    types: z.array(z.enum(CRASH_TYPES)).default(["crash", "anr", "native"]),
    since_minutes: z.number().int().min(1).optional().describe("Only crashes from the last N minutes"),
    limit: z.number().int().min(1).max(100).default(10),
  },
  onDevice(async (serial, a) => {
    await assertDevApp(serial, a.package);
    let crashes = await readCrashes(serial, a.package, a.types);
    if (a.since_minutes !== undefined) {
      const since = await deviceTimeMinutesAgo(serial, a.since_minutes);
      crashes = crashes.filter((c) => c.time >= since);
    }
    return text(formatCrashList(crashes.slice(0, a.limit), crashes.length));
  }),
);

tool(
  "get_crash",
  "Full report of one crash from list_crashes: header (process, version, time) and the complete stack trace.",
  {
    ...SERIAL,
    package: z.string(),
    id: z.string().describe("Id from list_crashes, e.g. crash@2026-10-22 13:57:56"),
    max_lines: z.number().int().min(10).max(2_000).default(200),
  },
  onDevice(async (serial, a) => {
    await assertDevApp(serial, a.package);
    const type = a.id.split("@")[0];
    if (!CRASH_TYPES.includes(type as never)) throw new ToolError(`Invalid crash id ${a.id}.`);
    const crashes = await readCrashes(serial, a.package, [type as (typeof CRASH_TYPES)[number]]);
    return text(formatCrash(findCrash(crashes, a.id), a.max_lines));
  }),
);

// ---- Act ---------------------------------------------------------------------------------------

tool(
  "tap",
  "Tap an element (by index, text or id) or a screen point (x, y).",
  { ...SERIAL, ...TARGET, ...OBSERVE },
  inDevApp(async (serial, a) => {
    const target = await resolveTarget(serial, a);
    await input.tap(serial, target.x, target.y);
    return [...text(`Tapped ${target.label}.`), ...(await observe(serial, a.observe, a.settle_ms))];
  }),
);

tool(
  "long_press",
  "Long-press an element (by index, text or id) or a screen point (x, y).",
  { ...SERIAL, ...TARGET, duration_ms: z.number().int().min(100).max(10_000).default(1000), ...OBSERVE },
  inDevApp(async (serial, a) => {
    const target = await resolveTarget(serial, a);
    await input.swipe(serial, target.x, target.y, target.x, target.y, a.duration_ms);
    return [...text(`Long-pressed ${target.label}.`), ...(await observe(serial, a.observe, a.settle_ms))];
  }),
);

tool(
  "swipe",
  "Swipe/drag from one screen point to another. A slow swipe (duration >= 1000) acts like a drag.",
  {
    ...SERIAL,
    from_x: z.number(),
    from_y: z.number(),
    to_x: z.number(),
    to_y: z.number(),
    duration_ms: z.number().int().min(10).max(10_000).default(300),
    ...OBSERVE,
  },
  inDevApp(async (serial, a) => {
    const d = await display(serial);
    const [x1, y1] = toDevice(d, a.from_x, a.from_y);
    const [x2, y2] = toDevice(d, a.to_x, a.to_y);
    await input.swipe(serial, x1, y1, x2, y2, a.duration_ms);
    return [
      ...text(`Swiped (${a.from_x},${a.from_y}) → (${a.to_x},${a.to_y}).`),
      ...(await observe(serial, a.observe, a.settle_ms)),
    ];
  }),
);

tool(
  "read_all",
  "Read a whole scrollable list or form in one call: scrolls it to the end and returns every entry it " +
    "contains, in order. Much cheaper than scrolling step by step. Afterwards the list stays at the end.",
  {
    ...SERIAL,
    index: z.number().int().optional().describe("[ref] of the scrollable; default: the largest one on screen"),
    direction: z.enum(["down", "right"]).default("down"),
    max_scrolls: z.number().int().min(1).max(50).default(20),
  },
  inDevApp(async (serial, a) => {
    let tree = await dumpTree(serial);
    const start = a.index !== undefined ? findByRef(tree, a.index) : largestScrollable(tree.elements);
    if (!start) {
      throw new ToolError(a.index !== undefined ? `Element [${a.index}] is not on screen.` : "Nothing scrollable on screen.");
    }
    const entries: string[] = [];
    const known = new Set<string>();
    const collect = (container: Element) => {
      let added = 0;
      for (const label of contentLabels(tree, container)) {
        if (!known.has(label)) {
          known.add(label);
          entries.push(label);
          added++;
        }
      }
      return added;
    };
    let container: Element = start;
    collect(container);
    let scrolls = 0;
    let reachedEnd = false;
    while (scrolls < a.max_scrolls) {
      const { x1, y1, x2, y2 } = container.bounds;
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const [fx, fy, tx, ty] = (
        a.direction === "down"
          ? [cx, cy + (y2 - y1) * 0.35, cx, cy - (y2 - y1) * 0.35]
          : [cx + (x2 - x1) * 0.35, cy, cx - (x2 - x1) * 0.35, cy]
      ).map(Math.round);
      await input.swipe(serial, fx, fy, tx, ty, 400);
      scrolls++;
      await sleep(250);
      tree = await dumpTree(serial);
      const next = findByRef(tree, start.ref) ?? largestScrollable(tree.elements);
      if (!next) break;
      container = next;
      if (collect(container) === 0) {
        reachedEnd = true;
        break;
      }
    }
    const status = reachedEnd
      ? `reached the end after ${scrolls} scroll(s)`
      : `stopped after ${scrolls} scroll(s) (raise max_scrolls to read further)`;
    return text(
      `${entries.length} entries, ${status}. The list is now scrolled to the end; use get_ui before acting on it.\n` +
        entries.join("\n"),
    );
  }),
);

tool(
  "scroll",
  "Scroll the content in a direction (down = reveal content below). Scrolls the given element (index), " +
    "otherwise the largest scrollable element on screen (the screen centre only when no UI tree is available).",
  {
    ...SERIAL,
    direction: z.enum(["up", "down", "left", "right"]),
    index: z.number().int().optional().describe("[ref] of the scrollable element"),
    amount: z.number().min(0.1).max(1).default(0.6).describe("Fraction of the area to scroll"),
    ...OBSERVE,
  },
  inDevApp(async (serial, a) => {
    let area: { x1: number; y1: number; x2: number; y2: number };
    if (a.index !== undefined) {
      const element = findByRef(await dumpTree(serial), a.index);
      if (!element) throw new ToolError(`Element [${a.index}] is no longer on screen; call get_ui.`);
      area = element.bounds;
    } else {
      const tree = await dumpTree(serial).catch(() => undefined);
      if (tree) {
        const scrollable = largestScrollable(tree.elements);
        if (!scrollable) {
          return text("Nothing scrollable on screen (the content fits); nothing done. Use swipe to drag something else.");
        }
        area = scrollable.bounds;
      } else {
        area = await screenArea(serial);
      }
    }
    const cx = (area.x1 + area.x2) / 2;
    const cy = (area.y1 + area.y2) / 2;
    const dx = ((area.x2 - area.x1) * a.amount) / 2;
    const dy = ((area.y2 - area.y1) * a.amount) / 2;
    // The finger moves opposite to the direction the content should reveal.
    const [fx, fy, tx, ty] = {
      down: [cx, cy + dy, cx, cy - dy],
      up: [cx, cy - dy, cx, cy + dy],
      right: [cx + dx, cy, cx - dx, cy],
      left: [cx - dx, cy, cx + dx, cy],
    }[a.direction].map(Math.round);
    await input.swipe(serial, fx, fy, tx, ty, 400);
    return [...text(`Scrolled ${a.direction}.`), ...(await observe(serial, a.observe, a.settle_ms))];
  }),
);

tool(
  "type_text",
  "Type text into the focused field. Optionally tap a target first to focus it, clear it, and press enter afterwards.",
  {
    ...SERIAL,
    value: z.string().describe("Printable ASCII text to type"),
    ...TARGET,
    clear: z.boolean().default(false).describe("Delete the existing text first"),
    submit: z.boolean().default(false).describe("Press enter afterwards"),
    ...OBSERVE,
  },
  inDevApp(async (serial, a) => {
    const steps: string[] = [];
    const hasTarget = a.index !== undefined || a.text !== undefined || a.id !== undefined || a.x !== undefined;
    let field: Element | undefined;
    if (hasTarget) {
      const target = await resolveTarget(serial, a);
      field = target.element;
      await input.tap(serial, target.x, target.y);
      steps.push(`tapped ${target.label}`);
      await sleep(300);
    }
    if (a.clear) {
      await input.clearField(serial, field?.text.length);
      steps.push("cleared");
    }
    if (!(await waitForFocusedField(serial))) steps.push("no focused text field found, typed anyway");
    await input.typeText(serial, a.value);
    steps.push(`typed ${JSON.stringify(a.value)}`);
    if (a.submit) {
      await input.pressKey(serial, "enter");
      steps.push("pressed enter");
    }
    return [...text(`${steps.join(", ")}.`), ...(await observe(serial, a.observe, a.settle_ms))];
  }),
);

tool(
  "press_key",
  `Press a key: ${input.KEY_NAMES.join(", ")}, any KEYCODE_* name, or a key code number.`,
  { ...SERIAL, key: z.string(), ...OBSERVE },
  inDevApp(async (serial, a) => {
    const code = await input.pressKey(serial, a.key);
    return [...text(`Pressed ${code}.`), ...(await observe(serial, a.observe, a.settle_ms))];
  }),
);

// Restore the animation settings however the server ends: normal exit, signal, or the client closing stdin.
process.on("exit", restoreAnimations);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
process.stdin.on("end", () => process.exit(0));

await server.connect(new StdioServerTransport());
console.error("android-mcp ready");

import { XMLParser } from "fast-xml-parser";
import { ToolError, adb, sleep } from "./adb.js";
import { agentSource, releaseForDump } from "./agent.js";
import { type Display, describeDisplay, observedDisplaySize, toScreen } from "./screen.js";

const DUMP_PATH = "/sdcard/window_dump.xml";
const DUMP_TIMEOUT_MS = 10_000;
const CHILD_LABEL_MAX = 120;

export const TREE_UNAVAILABLE =
  "UI tree unavailable (the screen never became idle, e.g. a map, video or animation is running). " +
  "Use screenshot and tap by x/y instead.";

export interface Element {
  index: number;
  /** Index of the parent element, -1 for roots. */
  parent: number;
  depth: number;
  cls: string;
  pkg: string;
  text: string;
  desc: string;
  id: string;
  /** Text of descendants, used as a label for clickable containers without text of their own. */
  childText: string;
  hasChildren: boolean;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  checkable: boolean;
  checked: boolean;
  enabled: boolean;
  focused: boolean;
  selected: boolean;
  editable: boolean;
  password: boolean;
}

export interface UiTree {
  serial: string;
  elements: Element[];
  packages: string[];
  display: Display;
  takenAt: number;
}

const lastTrees = new Map<string, UiTree>();

export function lastTree(serial: string): UiTree | undefined {
  return lastTrees.get(serial);
}

// preserveOrder keeps siblings in document order; the agent names elements by class (<android.widget.Button>),
// `uiautomator dump` uses <node class="…">, so tag names can't be used to group children.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", preserveOrder: true });

interface RawNode {
  attrs: Record<string, string>;
  children: RawNode[];
}

type OrderedEntry = Record<string, unknown> & { ":@"?: Record<string, string> };

function toRawNodes(entries: OrderedEntry[]): RawNode[] {
  const nodes: RawNode[] = [];
  for (const entry of entries) {
    const tag = Object.keys(entry).find((k) => k !== ":@");
    if (!tag || tag === "#text" || tag.startsWith("?")) continue;
    nodes.push({ attrs: entry[":@"] ?? {}, children: toRawNodes((entry[tag] as OrderedEntry[]) ?? []) });
  }
  return nodes;
}

/** The nodes below the <hierarchy> root. */
function parseHierarchy(xml: string): RawNode[] {
  const top = toRawNodes(parser.parse(xml) as OrderedEntry[]);
  return top.flatMap((n) => n.children);
}

function parseBounds(value: string | undefined) {
  const m = value?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return { x1: 0, y1: 0, x2: 0, y2: 0 };
  return { x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) };
}

function shortId(resourceId: string): string {
  const slash = resourceId.indexOf(":id/");
  return slash >= 0 ? resourceId.slice(slash + 4) : resourceId;
}

async function dumpXml(serial: string): Promise<string | undefined> {
  // Remove the old file first, so a failed dump is never answered with a stale tree.
  const command = `rm -f ${DUMP_PATH}; uiautomator dump ${DUMP_PATH} >/dev/null 2>&1; cat ${DUMP_PATH} 2>/dev/null`;
  try {
    const xml = (await adb(serial, ["exec-out", command], { timeoutMs: DUMP_TIMEOUT_MS })).toString("utf8");
    const start = xml.indexOf("<?xml");
    return start >= 0 ? xml.slice(start) : undefined;
  } catch {
    return undefined;
  }
}

async function readXml(serial: string): Promise<string | undefined> {
  const fromAgent = await agentSource(serial);
  if (fromAgent) return fromAgent;
  await releaseForDump(serial);
  const xml = await dumpXml(serial);
  if (xml) return xml;
  await sleep(500);
  return dumpXml(serial);
}

export async function dumpTree(serial: string): Promise<UiTree> {
  const xml = await readXml(serial);
  if (!xml) throw new ToolError(TREE_UNAVAILABLE);

  const roots = parseHierarchy(xml);
  const elements: Element[] = [];
  const packages = new Set<string>();
  let rootWidth = 0;
  let rootHeight = 0;

  const visit = ({ attrs: node, children }: RawNode, depth: number, parent: number): string[] => {
    const b = parseBounds(node.bounds);
    if (depth === 0) {
      rootWidth = Math.max(rootWidth, b.x2);
      rootHeight = Math.max(rootHeight, b.y2);
    }
    if (node.package) packages.add(node.package);
    const element: Element = {
      index: elements.length,
      parent,
      depth,
      cls: (node.class ?? "").split(".").pop() ?? "",
      pkg: node.package ?? "",
      text: node.text ?? "",
      desc: node["content-desc"] ?? "",
      id: shortId(node["resource-id"] ?? ""),
      childText: "",
      hasChildren: children.length > 0,
      bounds: b,
      clickable: node.clickable === "true",
      longClickable: node["long-clickable"] === "true",
      scrollable: node.scrollable === "true",
      checkable: node.checkable === "true",
      checked: node.checked === "true",
      enabled: node.enabled !== "false",
      focused: node.focused === "true",
      selected: node.selected === "true",
      editable: /EditText/.test(node.class ?? ""),
      password: node.password === "true",
    };
    elements.push(element);
    const texts = children.flatMap((child) => visit(child, depth + 1, element.index));
    element.childText = texts.join(" ").slice(0, CHILD_LABEL_MAX);
    const own = element.text || element.desc;
    return own ? [own] : texts;
  };
  for (const root of roots) visit(root, 0, -1);

  const display = observedDisplaySize(serial, rootWidth || 1, rootHeight || 1);
  const tree: UiTree = { serial, elements, packages: [...packages], display, takenAt: Date.now() };
  lastTrees.set(serial, tree);
  return tree;
}

function isInteractive(e: Element): boolean {
  return e.clickable || e.longClickable || e.scrollable || e.checkable || e.editable;
}

function isMeaningful(e: Element): boolean {
  const { x1, y1, x2, y2 } = e.bounds;
  if (x2 <= x1 || y2 <= y1) return false;
  // An id alone only marks leaves; ids on layout wrappers are noise.
  return !!(e.text || e.desc || (e.id && !e.hasChildren) || isInteractive(e));
}

/** Plain text already shown as the ~label of the clickable container around it. */
function isAbsorbed(tree: UiTree, e: Element): boolean {
  if (isInteractive(e)) return false;
  const own = e.text || e.desc;
  for (let p = e.parent; p >= 0; p = tree.elements[p].parent) {
    const ancestor = tree.elements[p];
    if (ancestor.clickable || ancestor.longClickable) {
      return !ancestor.text && !ancestor.desc && (!own || ancestor.childText.includes(own));
    }
  }
  return false;
}

function quote(s: string): string {
  return JSON.stringify(s.replace(/\s+/g, " ").trim());
}

export function formatTree(tree: UiTree, all: boolean): string {
  const d = tree.display;
  const shown = tree.elements.filter((e) => all || (isMeaningful(e) && !isAbsorbed(tree, e)));
  const shownSet = new Set(shown.map((e) => e.index));
  // Indent by the number of shown ancestors, so the skipped wrapper layers don't inflate the output.
  const level = new Map<number, number>();
  for (const e of shown) {
    let p = e.parent;
    while (p >= 0 && !shownSet.has(p)) p = tree.elements[p].parent;
    level.set(e.index, p >= 0 ? (level.get(p) ?? 0) + 1 : 0);
  }
  const lines = shown.map((e) => {
    const { x1, y1, x2, y2 } = e.bounds;
    const parts = [`${"  ".repeat(level.get(e.index) ?? 0)}[${e.index}]`, e.cls || "View"];
    if (e.text) parts.push(e.password ? '"•••"' : quote(e.text));
    if (e.desc) parts.push(`desc=${quote(e.desc)}`);
    if (!e.text && !e.desc && e.childText && (e.clickable || e.longClickable || all)) parts.push(`~${quote(e.childText)}`);
    if (e.id) parts.push(`id=${e.id}`);
    parts.push(
      `(${toScreen(d, (x1 + x2) / 2)},${toScreen(d, (y1 + y2) / 2)}) ${toScreen(d, x2 - x1)}x${toScreen(d, y2 - y1)}`,
    );
    const flags = [
      e.clickable && "clickable",
      e.longClickable && "long-clickable",
      e.scrollable && "scrollable",
      e.editable && "editable",
      e.checkable && (e.checked ? "checked" : "unchecked"),
      e.selected && "selected",
      e.focused && "focused",
      !e.enabled && "disabled",
    ].filter(Boolean);
    return [...parts, ...flags].join(" ");
  });
  const header =
    `packages: ${tree.packages.join(", ") || "?"} | ${describeDisplay(d)} | ` +
    `(x,y) = centre in screen coordinates, ~"…" = text of children`;
  return [header, ...lines].join("\n");
}


export interface Query {
  text?: string;
  id?: string;
  exact?: boolean;
}

export function findElements(tree: UiTree, q: Query): Element[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const matches = (value: string, wanted: string) =>
    !!value && (q.exact ? norm(value) === norm(wanted) : norm(value).includes(norm(wanted)));
  return tree.elements.filter((e) => {
    const { x1, y1, x2, y2 } = e.bounds;
    if (x2 <= x1 || y2 <= y1) return false;
    if (q.id !== undefined) return e.id === q.id || e.id.endsWith(`/${q.id}`) || (!q.exact && e.id.includes(q.id));
    if (q.text !== undefined) return matches(e.text, q.text) || matches(e.desc, q.text);
    return false;
  });
}

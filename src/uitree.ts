import { XMLParser } from "fast-xml-parser";
import { ToolError, adb, sleep } from "./adb.js";
import { agentSource, releaseForDump } from "./agent.js";
import { type Display, observedDisplaySize, toScreen } from "./screen.js";

const DUMP_PATH = "/sdcard/window_dump.xml";
const DUMP_TIMEOUT_MS = 10_000;
const CHILD_LABEL_MAX = 120;

export const TREE_UNAVAILABLE =
  "UI tree unavailable (the screen never became idle, e.g. a map, video or animation is running). " +
  "Use screenshot and tap by x/y instead.";

export interface Element {
  /** Position in this tree's element list (changes between reads). */
  index: number;
  /**
   * Number shown to the agent. It stays the same across reads as long as the element keeps its identity
   * (class, id, label), so a change report can refer to elements the agent saw earlier.
   */
  ref: number;
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

interface RefState {
  refs: Map<string, number>;
  next: number;
}

/**
 * Refs start at a random base per server process, so a ref remembered from before a restart almost never
 * names a different element of the new numbering; it fails with "no longer on screen" instead.
 */
const REF_BASE = 1000 + Math.floor(Math.random() * 8000);

const refStates = new Map<string, RefState>();

/** What the agent last saw per device: ref -> line without position, plus the packages on screen. */
const seen = new Map<string, { lines: Map<number, string>; packages: string }>();

function identity(e: Element): string {
  // Scrollables and text fields keep their ref while their content changes.
  if (e.scrollable) return `${e.cls}|${e.id}|${e.bounds.x1},${e.bounds.y1},${e.bounds.x2},${e.bounds.y2}`;
  if (e.editable) return `${e.cls}|${e.id}`;
  const label = e.text || e.desc || e.childText || e.id;
  // Without any label only the position tells elements apart; a moved unlabelled element gets a new ref.
  if (!label) return `${e.cls}|@${e.bounds.x1},${e.bounds.y1},${e.bounds.x2},${e.bounds.y2}`;
  return `${e.cls}|${e.id}|${e.text}|${e.desc}|${e.text || e.desc ? "" : e.childText}`;
}

function assignRefs(serial: string, elements: Element[]): void {
  const state = refStates.get(serial) ?? { refs: new Map(), next: REF_BASE };
  refStates.set(serial, state);
  const occurrences = new Map<string, number>();
  for (const e of elements) {
    const base = identity(e);
    const n = occurrences.get(base) ?? 0;
    occurrences.set(base, n + 1);
    const key = `${base}#${n}`;
    let ref = state.refs.get(key);
    if (ref === undefined) {
      ref = state.next++;
      state.refs.set(key, ref);
    }
    e.ref = ref;
  }
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
      ref: 0,
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
  assignRefs(serial, elements);
  return { serial, elements, packages: [...packages], display, takenAt: Date.now() };
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

/** Classes worth naming; the many View/TextView/layout classes add tokens but no information. */
const NAMED_CLASSES =
  /^(Button|ImageButton|EditText|Switch|CheckBox|RadioButton|ToggleButton|SeekBar|Spinner|ProgressBar|ImageView|WebView|ScrollView|HorizontalScrollView|RecyclerView|ListView|GridView|ViewPager|TabWidget)$/;

interface Line {
  ref: number;
  /** Line without indentation and position, used to detect changes. */
  label: string;
  text: string;
}

function shownElements(tree: UiTree, all: boolean): Element[] {
  return tree.elements.filter((e) => all || (isMeaningful(e) && !isAbsorbed(tree, e)));
}

export function describeLabel(e: Element, all = false): string {
  const parts: string[] = [];
  if (all || NAMED_CLASSES.test(e.cls)) parts.push(e.cls || "View");
  if (e.text) parts.push(e.password ? '"•••"' : quote(e.text));
  if (e.desc) parts.push(`desc=${quote(e.desc)}`);
  if (!e.text && !e.desc && e.childText && (e.clickable || e.longClickable || all)) parts.push(`~${quote(e.childText)}`);
  if (e.id) parts.push(`id=${e.id}`);
  const flags = [
    e.clickable && "clickable",
    e.longClickable && "long-clickable",
    e.scrollable && "scrollable",
    e.editable && "editable",
    e.checkable && (e.checked ? "checked" : "unchecked"),
    e.selected && "selected",
    e.focused && "focused",
    !e.enabled && "disabled",
  ].filter(Boolean) as string[];
  return [...parts, ...flags].join(" ");
}

function formatLines(tree: UiTree, all: boolean): Line[] {
  const d = tree.display;
  const shown = shownElements(tree, all);
  const shownSet = new Set(shown.map((e) => e.index));
  // Indent by the number of shown ancestors, so the skipped wrapper layers don't inflate the output.
  const level = new Map<number, number>();
  for (const e of shown) {
    let p = e.parent;
    while (p >= 0 && !shownSet.has(p)) p = tree.elements[p].parent;
    level.set(e.index, p >= 0 ? (level.get(p) ?? 0) + 1 : 0);
  }
  return shown.map((e) => {
    const { x1, y1, x2, y2 } = e.bounds;
    const label = describeLabel(e, all);
    const position = `(${toScreen(d, (x1 + x2) / 2)},${toScreen(d, (y1 + y2) / 2)}) ${toScreen(d, x2 - x1)}x${toScreen(d, y2 - y1)}`;
    const [head, ...flags] = splitFlags(label);
    const text = `${"  ".repeat(level.get(e.index) ?? 0)}[${e.ref}] ${[head, position, ...flags].filter(Boolean).join(" ")}`;
    return { ref: e.ref, label, text };
  });
}

const FLAG_RE = /^(clickable|long-clickable|scrollable|editable|checked|unchecked|selected|focused|disabled)$/;

/** Splits a label into its descriptive part and its trailing flags, so the position goes in between. */
function splitFlags(label: string): string[] {
  const words = label.split(" ");
  let i = words.length;
  while (i > 0 && FLAG_RE.test(words[i - 1])) i--;
  return [words.slice(0, i).join(" "), ...words.slice(i)];
}

function header(tree: UiTree): string {
  const d = tree.display;
  return `${tree.packages.join(", ") || "?"} | screen ${toScreen(d, d.width)}x${toScreen(d, d.height)} | [ref] (x,y)=centre wxh, ~"…"=children's text`;
}

function remember(tree: UiTree, lines: Line[]): void {
  seen.set(tree.serial, { lines: new Map(lines.map((l) => [l.ref, l.label])), packages: tree.packages.join(",") });
}

export function formatTree(tree: UiTree, all: boolean): string {
  const lines = formatLines(tree, all);
  if (!all) remember(tree, lines);
  return [header(tree), ...lines.map((l) => l.text)].join("\n");
}

/**
 * Only what changed since the agent last saw the screen. A new screen (other package, most elements
 * replaced) is returned in full.
 */
export function formatChanges(tree: UiTree): string {
  const lines = formatLines(tree, false);
  const before = seen.get(tree.serial);
  if (!before || before.packages !== tree.packages.join(",")) return formatTree(tree, false);
  const added = lines.filter((l) => !before.lines.has(l.ref));
  const changed = lines.filter((l) => before.lines.has(l.ref) && before.lines.get(l.ref) !== l.label);
  const current = new Set(lines.map((l) => l.ref));
  const removed = [...before.lines].filter(([ref]) => !current.has(ref));
  const kept = lines.length - added.length;
  if (kept < lines.length / 2) return formatTree(tree, false);
  remember(tree, lines);
  if (!added.length && !changed.length && !removed.length) return `No visible change (${lines.length} elements).`;
  const out = [
    `Changes (${kept} other elements unchanged, positions may have moved; refs stay valid; get_ui for the full list):`,
    ...added.map((l) => `+ ${l.text.trimStart()}`),
    ...changed.map((l) => `~ ${l.text.trimStart()}`),
  ];
  if (removed.length) {
    out.push(`- gone: ${removed.map(([ref, label]) => `[${ref}] ${splitFlags(label)[0] || "(unlabelled)"}`).join(", ")}`);
  }
  return out.join("\n");
}

export function findByRef(tree: UiTree, ref: number): Element | undefined {
  return tree.elements.find((e) => e.ref === ref);
}

/** Labels of the visible descendants of `container`, in screen order, for read_all. */
export function contentLabels(tree: UiTree, container: Element): string[] {
  const inside = (e: Element) => {
    for (let p = e.parent; p >= 0; p = tree.elements[p].parent) if (p === container.index) return true;
    return false;
  };
  return shownElements(tree, false)
    .filter(inside)
    .map((e) => describeLabel(e))
    .filter((label) => splitFlags(label)[0]);
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

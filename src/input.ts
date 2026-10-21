import { ToolError, shQuote, shell } from "./adb.js";

const DEFAULT_CLEAR_CHARS = 80;
const MAX_CLEAR_CHARS = 400;

const KEYS: Record<string, string> = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  enter: "KEYCODE_ENTER",
  del: "KEYCODE_DEL",
  backspace: "KEYCODE_DEL",
  forward_del: "KEYCODE_FORWARD_DEL",
  tab: "KEYCODE_TAB",
  escape: "KEYCODE_ESCAPE",
  app_switch: "KEYCODE_APP_SWITCH",
  menu: "KEYCODE_MENU",
  search: "KEYCODE_SEARCH",
  power: "KEYCODE_POWER",
  wakeup: "KEYCODE_WAKEUP",
  volume_up: "KEYCODE_VOLUME_UP",
  volume_down: "KEYCODE_VOLUME_DOWN",
  dpad_up: "KEYCODE_DPAD_UP",
  dpad_down: "KEYCODE_DPAD_DOWN",
  dpad_left: "KEYCODE_DPAD_LEFT",
  dpad_right: "KEYCODE_DPAD_RIGHT",
  dpad_center: "KEYCODE_DPAD_CENTER",
  move_home: "KEYCODE_MOVE_HOME",
  move_end: "KEYCODE_MOVE_END",
};

export const KEY_NAMES = Object.keys(KEYS);

export async function tap(serial: string, x: number, y: number): Promise<void> {
  await shell(serial, `input tap ${x} ${y}`);
}

export async function swipe(
  serial: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
): Promise<void> {
  await shell(serial, `input swipe ${x1} ${y1} ${x2} ${y2} ${Math.round(durationMs)}`);
}

export async function typeText(serial: string, text: string): Promise<void> {
  if (/[^\x20-\x7e]/.test(text)) {
    throw new ToolError("type_text only supports printable ASCII (adb `input text` limitation); newlines: use press_key enter.");
  }
  // `input text` turns %s into a space; real spaces would split the argument.
  await shell(serial, `input text ${shQuote(text.replace(/ /g, "%s"))}`);
}

/** Deletes the content of the focused field: jump to the end, then delete backwards. */
export async function clearField(serial: string, knownLength?: number): Promise<void> {
  const count = Math.min(MAX_CLEAR_CHARS, (knownLength ?? DEFAULT_CLEAR_CHARS) + 5);
  await shell(serial, `input keyevent KEYCODE_MOVE_END ${Array(count).fill("KEYCODE_DEL").join(" ")}`);
}

export async function pressKey(serial: string, key: string): Promise<string> {
  const code = KEYS[key.toLowerCase()] ?? (/^(KEYCODE_[A-Z0-9_]+|\d+)$/.test(key) ? key : undefined);
  if (!code) throw new ToolError(`Unknown key "${key}". Use one of ${KEY_NAMES.join(", ")}, a KEYCODE_* name or a number.`);
  await shell(serial, `input keyevent ${code}`);
  return code;
}

# android-mcp

MCP server that lets an agent use the Android app you are developing, on a local emulator or a real device, the way
a person does: look at the screen, tap, swipe, type, press keys, wait for things to appear and read logcat. It drives
the devices through `adb`, so every device Android Studio sees works here too.

## Only Android Studio dev builds

The server only works with apps installed by **Run in Android Studio**. A package qualifies when all of these hold
(read from `dumpsys package`):

- `DEBUGGABLE`: a debug build.
- `TEST_ONLY`: Android Studio injects `android:testOnly="true"` into builds started from the IDE, and such APKs can
  only be installed with `adb install -t`, never through the Play Store or the package installer. A
  `./gradlew installDebug` from the command line doesn't set it, so those installs are refused as well.
- `initiatingPackageName=com.android.shell` (Android 11+): installed over adb.

Enforcement:

- `launch_app`, `stop_app`, `clear_app_data`, `open_url` and `logcat` only accept such a package.
- Screen tools (`get_ui`, `screenshot`, `wait_for`, `tap`, `long_press`, `swipe`, `scroll`, `type_text`,
  `press_key`) check the foreground activity first and refuse while any other app is in front. The exception is the
  system permission dialog, so runtime permission prompts of the dev app can be answered.
- When an action leaves the app (e.g. `press_key home`), the response says so instead of showing the screen.
- There is no install tool: install via Android Studio.

## On-device agent (fast UI reads)

The UI tree is read through **Appium's UiAutomator2 server** ([appium-uiautomator2-server](https://www.npmjs.com/package/appium-uiautomator2-server),
Apache-2.0), which stays running on the device and keeps its accessibility connection open:

- A UI read takes ~0.4 s instead of 2.5–3 s with `uiautomator dump`, and it does not wait for the screen to become idle.
- Starting it costs ~2 s once per session. It is installed automatically the first time (two APKs:
  `io.appium.uiautomator2.server` and `io.appium.uiautomator2.server.test`). They are not dev builds, so the dev-app
  restriction never lets the tools drive them.
- Compose test tags are exposed as `id=` (`mapTestTagToResourceId`).
- If the agent can't be started, the tree falls back to `uiautomator dump`. Set `ANDROID_MCP_AGENT=0` in the server's
  environment to always use the dump.
- Only one process can hold the accessibility connection, so the server is stopped before falling back to a dump, and
  other UiAutomator tools (Appium, Maestro) can't run against the device at the same time.
- Remove it from a device with `adb uninstall io.appium.uiautomator2.server.test && adb uninstall io.appium.uiautomator2.server`.

The APKs come from the npm dependency at install time; this repo does not redistribute them.

## Setup

Requirements: Node 20+, the Android SDK platform-tools (`adb`) and, for AVDs, the emulator. The SDK is found
via `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Android/Sdk`, `~/Library/Android/sdk` or `PATH`.

```bash
npm install
npm run build
claude mcp add --scope user android -- node "$PWD/dist/index.js"
```

During development `npm run dev` (tsx) runs the sources directly; rebuild and run `/mcp` → reconnect in Claude Code
after changes.

### Real devices

- USB: enable *Developer options → USB debugging*, plug in, accept the RSA prompt.
- Wi-Fi (Android 11+): *Developer options → Wireless debugging → Pair device with pairing code*, then
  `adb pair <ip>:<pair-port>` and `adb connect <ip>:<port>`.

When several devices are connected, every tool needs `serial` (from `list_devices`).

## Tools

| Area | Tools |
|---|---|
| Devices | `list_devices`, `start_emulator`, `get_screen_info`, `set_orientation` |
| Apps | `list_dev_apps`, `current_app`, `launch_app`, `stop_app`, `clear_app_data`, `open_url` |
| Observe | `get_ui`, `read_all`, `screenshot`, `wait_for` |
| Diagnose | `logcat`, `list_crashes`, `get_crash` |
| Act | `tap`, `long_press`, `swipe`, `scroll`, `type_text`, `press_key` |

- **One coordinate space.** Screenshots are downscaled so the long edge is at most 768 px (image tokens grow with the
  pixel count). `get_ui` reports element centres in the same space, and every x/y input uses it, so a point read off a
  screenshot can be tapped as is. `screenshot` with `region` returns a sharper crop for reading small text; a crop's
  pixels are not screen coordinates.
- **Stable refs.** Every element has a `[ref]` that stays the same across calls as long as the element keeps its
  identity (class, id, label). Refs start at a random base per server process, so refs from before a restart fail
  instead of hitting another element.
- **Act + observe in one call.** Action tools wait `settle_ms` (300 ms default) and then report, by default
  (`observe: "changes"`), only what changed since the agent last saw the screen: added (`+`), changed (`~`) and gone
  (`-`) elements, or "No visible change". A new screen comes back in full. `ui`, `screenshot`, `both` and `none` are
  available too.
- **`read_all`** scrolls a list or form to its end and returns all entries in one call, instead of one call (and one
  model turn) per scroll.
- **Targets.** `tap`/`long_press`/`type_text` take `index` (a `[ref]`), `text` (text or content description,
  substring unless `exact`), `id` (resource id / Compose test tag), or `x`+`y`. Refs are looked up in a fresh read,
  so they always tap the element's current position.
- **`get_ui` output** lists only visible elements that carry text, a description, a leaf id or an interaction
  flag. A clickable container without its own text shows its children's text as `~"…"`, and those children are
  folded into it. `all: true` shows every node.
- **No tree?** If neither the agent nor `uiautomator dump` delivers a tree, the tools say so and `get_ui` returns a
  screenshot instead: continue with x/y taps.
- **`logcat`** filters by the app's uid, so lines of a crashed earlier process are still included.
  By default each call only returns lines that are new since the previous call with the same filters.
- **Crash notices.** Every screen tool and `launch_app`/`open_url` check the app for new crashes, ANRs and native
  crashes after acting (~75 ms) and put a `⚠ … crashed: <exception> at <frame>` notice with the `get_crash` id in front
  of the result, or of the error if the action failed. Crashes that happen between two calls are reported with the next
  call; each crash is reported once.
- **Animations off.** On first use of a device the server sets the window, transition and animator duration scales to
  0, so steps are faster and the UI is settled when it is read. The original values are restored when the server
  exits (also on SIGINT/SIGTERM and when the client closes stdin) and kept in `$TMPDIR/android-mcp-animations-<serial>.json`
  meanwhile, so a server that was killed hard doesn't make the next one treat 0 as original. If a server was
  killed hard (`kill -9`), the next server restores the device when it exits. Set `ANDROID_MCP_KEEP_ANIMATIONS=1` to
  leave the settings alone.
- **`list_crashes` / `get_crash`** read the system DropBox (`dumpsys dropbox`): Java crashes, ANRs and native
  crashes of the app, newest first, each with exception and top frame; `get_crash` returns the full report with the
  complete stack trace. Unlike logcat, these reports survive the process and log rotation. `since_minutes` limits the
  list to recent crashes.
- **`start_emulator`** waits up to ~40 s per call (below the MCP request timeout); call it again to keep waiting.
  Emulator output goes to `$TMPDIR/android-mcp-emulator-<avd>.log`.

## Token usage

Each tool call is one model turn, and every turn re-reads the whole conversation. Long UI sessions inside a big coding
conversation get expensive because of that, not because of the tool output. Run UI testing in a fresh session or in
a subagent with a small context: a ready-made Claude Code subagent definition (`android-tester`, Sonnet, android tools
only) can live in `~/.claude/agents/android-tester.md`.

## Typical loop

1. Install the app with Run in Android Studio, then `list_dev_apps`.
2. `launch_app` → read the returned UI tree.
3. `tap` / `type_text` / `scroll` and read the new state from each response; `wait_for` text after navigation
   or loading instead of sleeping.
4. `list_crashes` to see whether the app crashed, `get_crash` for the stack trace, and `logcat` with `level: "E"` for
   errors that didn't crash it.

## Limitations

- `type_text` supports printable ASCII only (`adb shell input text`). Use `press_key enter` for new lines.
- No multi-touch gestures (pinch). Zoom maps with double-tap or their zoom controls.
- Compose test tags appear as `id=` only if the app sets `Modifier.semantics { testTagsAsResourceId = true }` at its
  root (worth enabling in debug builds); otherwise target Compose elements by text or content description.
- Screenshots take ~1 s (`screencap`) and cost far more tokens than the tree; ask for them only where the tree is not
  enough.

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
| Observe | `get_ui`, `screenshot`, `wait_for`, `logcat` |
| Act | `tap`, `long_press`, `swipe`, `scroll`, `type_text`, `press_key` |

- **One coordinate space.** Screenshots are downscaled so the long edge is at most 1280 px. `get_ui` reports
  element centres in the same space, and every x/y input uses it, so a point read off a screenshot can be tapped as is.
- **Act + observe in one call.** Action tools wait `settle_ms` (300 ms default) and return the new UI tree
  (`observe: "ui"`), a screenshot, both, or nothing.
- **Targets.** `tap`/`long_press`/`type_text` take `index` (from the last `get_ui`), `text` (text or content
  description, substring unless `exact`), `id` (resource id / Compose test tag), or `x`+`y`.
- **`get_ui` output** lists only visible elements that carry text, a description, a leaf id or an interaction
  flag. A clickable container without its own text shows its children's text as `~"…"`, and those children are
  folded into it. `all: true` shows every node.
- **No tree?** If neither the agent nor `uiautomator dump` delivers a tree, the tools say so and `get_ui` returns a
  screenshot instead: continue with x/y taps.
- **`logcat`** filters by the app's uid, so lines of a crashed earlier process are still included.
  By default each call only returns lines that are new since the previous call with the same filters.
- **`start_emulator`** waits up to ~40 s per call (below the MCP request timeout); call it again to keep waiting.
  Emulator output goes to `$TMPDIR/android-mcp-emulator-<avd>.log`.

## Typical loop

1. Install the app with Run in Android Studio, then `list_dev_apps`.
2. `launch_app` → read the returned UI tree.
3. `tap` / `type_text` / `scroll` and read the new state from each response; `wait_for` text after navigation
   or loading instead of sleeping.
4. `logcat` with `package` and `level: "E"` to catch crashes and errors.

## Limitations

- `type_text` supports printable ASCII only (`adb shell input text`). Use `press_key enter` for new lines.
- No multi-touch gestures (pinch). Zoom maps with double-tap or their zoom controls.
- Compose test tags appear as `id=` only if the app sets `Modifier.semantics { testTagsAsResourceId = true }` at its
  root (worth enabling in debug builds); otherwise target Compose elements by text or content description.
- Screenshots take ~1 s (`screencap`). Prefer `observe: "ui"` and only ask for screenshots where the tree is not enough.

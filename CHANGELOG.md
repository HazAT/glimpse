# Changelog

## Unreleased

- **Feature**: `--no-dock` flag / `noDock` option — hide the dock icon and app switcher entry on macOS. The window still works normally (focus, keyboard input, etc.) but the app stays invisible in the dock. Useful for embedded/subprocess usage where no dock presence is desired.

## 0.6.2

- **Fix**: Include `chromium-backend.mjs` in npm `files` array — the Chromium CDP backend was missing from published packages, breaking the Linux fallback. Thanks [@fredheir](https://github.com/fredheir)! ([#9](https://github.com/HazAT/glimpse/pull/9))

## 0.6.1

- **Change**: Companion is now hidden by default — enable it with `/companion`. Previously it was shown by default. Existing preferences in `~/.pi/companion.json` are respected.

## 0.6.0

Two community contributions expanding Linux support — thank you [@Whamp](https://github.com/Whamp) and [@hjanuschka](https://github.com/hjanuschka)! 🎉

### Chromium CDP Backend for Linux — [@hjanuschka](https://github.com/hjanuschka) ([#8](https://github.com/HazAT/glimpse/pull/8))

A zero-compile alternative to the native WebKitGTK backend. When the Rust binary isn't built, Glimpse automatically falls back to spawning system Chromium via `--remote-debugging-pipe` and speaking CDP over FDs 3/4. A ~1k line Node module (`src/chromium-backend.mjs`) translates between the Glimpse JSON Lines protocol and CDP — callers see no difference.

```bash
GLIMPSE_BACKEND=chromium node my-app.mjs  # force Chromium
GLIMPSE_BACKEND=native node my-app.mjs    # force native
# or just don't build the Rust binary and it kicks in automatically
```

No Rust toolchain, no GTK dev packages — just a Chromium-based browser installed on the system. This also unlocks capabilities the native Linux backend couldn't provide:

- **Follow cursor on X11** — polls via `xdotool` (plus native Hyprland IPC on Wayland)
- **Status item / system tray** — lightweight inline Python GTK helper, click toggles the window
- **Open links externally** — intercepts navigations via CDP Fetch, hands off to `xdg-open`
- Full window mode support: frameless, transparent, floating, click-through

### Linux CLI Fixes — [@Whamp](https://github.com/Whamp) ([#7](https://github.com/HazAT/glimpse/pull/7))

Two bugs that prevented the Linux native binary from launching correctly:

- **Fix: negative number CLI args** — `--cursor-offset-y -20` was parsed by clap as a flag instead of a value. Switched to `=` syntax (`--cursor-offset-y=-20`) for negative numbers.
- **Fix: platform-gated options** — `--open-links` and `--open-links-app` were passed on Linux but only implemented for macOS, causing "unexpected argument" errors. These flags are now skipped on non-macOS platforms.

## 0.5.1

### Windows Fixes

Three bugs that made the Windows WebView2 host unreliable in practice:

- **Fix: `window.glimpse.send()` silently failed for non-object values** — Sending a plain string, number, or boolean (e.g. `send('hello world')`) was silently swallowed. The JS bridge used `JSON.stringify(data)` + `postMessage(string)`, but WebView2's `TryGetWebMessageAsString` stripped the JSON encoding, making the C# side unable to parse it. The bridge now wraps all payloads in an envelope object (`{ __glimpse_msg: true, data }`) so `postMessage` always sends an object regardless of the user's data type.

- **Fix: `prompt()` pipe race with `autoClose`** — `CloseOnce()` called `Environment.Exit(0)` immediately after writing the "closed" message, which could kill the process before Node read the pipe. Now uses `Application.Exit()` for graceful form shutdown with a 100ms delayed `Environment.Exit(0)` fallback (needed because the stdin reader thread blocks process termination).

- **Fix: .NET version compatibility** — Added `<RollForward>LatestMajor</RollForward>` to the csproj so the binary runs on .NET 9+ without requiring .NET 8 to be installed.

### Skill

- Updated SKILL.md to reflect cross-platform support (was macOS-only language)
- Added Windows-specific tips: `file:///` ESM imports, `addEventListener` over inline handlers, `floating: true` for sequential prompts

## 0.5.0

### Cross-Platform Support

Glimpse now runs on **macOS**, **Linux**, and **Windows**. The core protocol and Node.js API remain identical across platforms — write once, render everywhere.

#### Linux — Rust + GTK4 + WebKitGTK

Native Linux binary using Rust with GTK4 and WebKitGTK (webkit6). Supports the full Glimpse protocol including `follow-cursor` on Hyprland via its IPC socket. Other Wayland compositors and X11 do not yet support cursor tracking.

Inspired by [@thomaspeklak](https://github.com/thomaspeklak)'s Linux PR ([#4](https://github.com/HazAT/glimpse/pull/4)).

Requirements: Rust toolchain, GTK4, WebKitGTK 6.0, gtk4-layer-shell dev packages.

#### Windows — .NET 8 + WebView2

Native Windows host using .NET 8 and Microsoft Edge WebView2. Supports the full Glimpse protocol including `follow-cursor` with spring physics, transparent/frameless windows, and click-through.

Inspired by [@Dwsy](https://github.com/Dwsy)'s Windows PR ([#3](https://github.com/HazAT/glimpse/pull/3)).

Requirements: .NET 8 SDK, Microsoft Edge WebView2 Runtime.

#### Platform Infrastructure

- **Unified build system** — `scripts/build.mjs` handles macOS (swiftc), Linux (cargo), and Windows (dotnet publish). Platform-aware `postinstall` gracefully skips when toolchains are missing.
- **Platform detection** — `resolveNativeHost()` in `glimpse.mjs` resolves the correct binary per platform. `GLIMPSE_BINARY_PATH` / `GLIMPSE_HOST_PATH` env vars override.
- **Feature capability gating** — `supportsFollowCursor()` and `getFollowCursorSupport()` detect runtime support. `statusItem()` throws on non-macOS. `openLinks` is macOS-only. The companion extension gracefully disables on unsupported platforms.
- **Cross-platform companion IPC** — Unix domain sockets on macOS/Linux, named pipes on Windows.
- **Build commands** — `npm run build:macos`, `npm run build:linux`, `npm run build:windows`
- **Platform test** — `npm run test:platform` validates host resolution and socket paths

## 0.4.0

Two community contributions land in this release — thank you! 🎉

### Menu Bar Mode — [@vtemian](https://github.com/vtemian) ([#5](https://github.com/HazAT/glimpse/pull/5))

Glimpse can now live in your menu bar. The new `statusItem()` API creates a menu bar icon with a popover WebView — click the icon to show/hide your HTML content. Comes with `setTitle()` to update the menu bar label and `resize()` to change the popover dimensions on the fly.

```js
import { statusItem } from 'glimpseui';

const item = statusItem('<h1>Hello from the menu bar</h1>', {
  title: '👁', width: 300, height: 200
});
item.on('click', () => console.log('popover toggled'));
```

CLI: `glimpse --status-item --title "👁" --width 300 --height 200`

### Open Links Externally — [@joemccann](https://github.com/joemccann) ([#6](https://github.com/HazAT/glimpse/pull/6))

Links clicked inside Glimpse can now open in your system browser (or a specific app) instead of navigating within the WebView. Useful for dashboards, documentation viewers, or any UI where outbound links should escape the window.

```js
const win = open(html, { openLinks: true });
// or with a specific browser:
const win = open(html, { openLinks: true, openLinksApp: '/Applications/Firefox.app' });
```

CLI: `glimpse --open-links` or `glimpse --open-links-app "/Applications/Google Chrome.app"`

Also adds `GLIMPSE_BINARY_PATH` env var to override the compiled binary location.

## 0.3.7

Companion remembers your preference — disable it once and it stays off across sessions.

- **Feature**: Persist companion enabled/disabled state to `~/.pi/companion.json`
- **Improvement**: `/companion` toggle now saves immediately; new sessions respect the saved preference

## 0.3.6

Broken release — settings path used `~/.config/glimpse/` which doesn't exist when installed from git.

## 0.3.5

Hidden window prewarm mode — open a window invisibly, let the WebView load content in the background, then reveal it instantly with the `show` command. Useful for eliminating perceived latency in agents and tools that know they'll need a window soon.

- **Feature**: `hidden` option / `--hidden` CLI flag — starts the window off-screen with accessory activation policy
- **Feature**: `show` protocol command — reveals a hidden window, optionally setting the title, and activates the app
- **Feature**: `win.show(options?)` method on the Node wrapper

## 0.3.4

- **Chore**: Update repository URL and author in package.json

## 0.3.3

- **Docs**: Add `pi install npm:glimpseui` instructions and `/companion` command to README

## 0.3.2

Housekeeping release — better docs, organized tests, and a demo video.

- **Docs**: Add performance benchmarks to README (warm start ~310ms, cold start ~2s on Apple Silicon)
- **Docs**: Embed demo video at the top of README for GitHub and pi package registry
- **Chore**: Move tests from root `test.mjs` to `test/` directory
- **Fix**: Update publish script to use `npm test` instead of hardcoded `test.mjs` path
- **Skill**: Use resolved absolute import paths instead of bare `'glimpseui'` specifier (fixes imports from `/tmp`)

## 0.3.1

Fix pi package skill discovery errors when installing via `pi install npm:glimpseui`.

- **Fix**: Move `SKILL.md` to `skills/glimpse/` so parent directory matches skill name
- **Fix**: Change `pi.skills` path from `"."` to `"./skills"` — prevents CHANGELOG.md and README.md from being picked up as skills

## 0.3.0

Ship as a unified pi package — `npm install glimpseui` works standalone, `pi install npm:glimpseui` installs the companion extension and skill automatically. No separate extension setup needed.

- **Unified package**: Extension and skill bundled in the main npm package via `pi` manifest in `package.json`
- **Removed**: Separate `pi-extension/package.json` — no more nested install step

## 0.2.0

System info API. The `ready` event now includes screen geometry, display info, cursor position, and dark/light mode — everything you need to adapt UI to the user's environment.

- **System info on ready**: `screen`, `appearance` (dark mode, accent color, tint color), `cursor` position, and `screens` array
- **Runtime info**: `get-info` protocol command to re-query system state at any time
- **Node wrapper**: `win.info` getter caches the latest system info

## 0.1.1

Minor polish to the demo window.

- **Demo fix**: Close demo window on Escape, Enter, or button click

## 0.1.0

Initial release. Two source files, zero dependencies — a native macOS WKWebView that speaks JSON Lines.

**Core:**
- Native Swift binary (~420 lines) — single-file compilation with `swiftc`, no Xcode required
- Node.js ESM wrapper (~175 lines) — `EventEmitter` API over stdin/stdout
- Bidirectional JSON Lines protocol: send HTML/JS in, get messages/events out
- Sub-50ms window open time

**Window modes:**
- Standard, frameless, floating, transparent, click-through — combine freely
- Cursor-following with configurable offset
- Keyboard support in all modes including frameless

**API:**
- `open()` — open a window with HTML string or options
- `prompt()` — open a window and await a single response (ideal for dialogs/forms)
- `loadFile()` — load HTML from a file path
- `autoClose` — close window automatically when the first message is received
- `npx glimpseui` CLI with built-in demo

**Post-0.1.0 (unreleased at the time, shipped in 0.2.0+):**

Pi companion extension — a floating status pill that follows your cursor and shows what your pi agents are doing in real time.

- **Companion extension**: `/companion` command toggles a cursor-following overlay
- **Multi-agent support**: Shared window via Unix socket IPC — multiple pi sessions report to one pill
- **Spring physics**: Smooth cursor following with `--follow-mode spring`
- **Cursor anchoring**: Snap window to cursor corners (`top-right`, `bottom-left`, etc.) with safe-zone awareness
- **Live status**: Dot color, activity label (Reading, Editing, Running...), file/command detail, elapsed time, context window usage %
- **Dark/light mode**: Adapts text stroke and colors to system appearance

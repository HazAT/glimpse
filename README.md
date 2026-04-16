# Glimpse

Native micro-UI for scripts and agents. macOS, Linux, and Windows.

https://github.com/user-attachments/assets/57822cd2-4606-4865-a555-d8ccacd31b40

Glimpse opens a native WebView window and speaks a bidirectional JSON Lines protocol over stdin/stdout. No Electron, no browser — just a tiny native binary and a Node.js wrapper.

| Platform | Backend | Requirements |
|----------|---------|--------------|
| macOS | Swift + WKWebView | Xcode Command Line Tools |
| Linux | Rust + GTK4 + WebKitGTK | Rust toolchain, GTK4/WebKitGTK dev packages |
| Linux | Chromium CDP (zero-compile) | Any Chromium-based browser |
| Windows | .NET 8 + WebView2 | .NET 8 SDK, Edge WebView2 Runtime |

## Install

```bash
npm install glimpseui
```

`npm install` runs a `postinstall` hook that compiles the native binary for your platform. If the required toolchain isn't found, the build is skipped with a warning — you can compile manually later.

**Manual build:**
```bash
npm run build            # auto-detect platform
npm run build:macos      # swiftc
npm run build:linux      # cargo build --release
npm run build:windows    # dotnet publish
```

### Pi Agent Package

```bash
pi install npm:glimpseui
```

Installs the Glimpse skill and companion extension for [pi](https://github.com/mariozechner/pi). The companion is a floating status pill that follows your cursor showing what your agents are doing in real-time. It's hidden by default — enable it with the `/companion` command.

## Quick Start

```js
import { open } from 'glimpseui';

const win = open(`
  <html>
    <body style="font-family: sans-serif; padding: 2rem;">
      <h2>Hello from Glimpse</h2>
      <button onclick="glimpse.send({ action: 'greet' })">Say hello</button>
    </body>
  </html>
`, { width: 400, height: 300, title: 'My App' });

win.on('message', (data) => {
  console.log('Received:', data); // { action: 'greet' }
  win.close();
});

win.on('closed', () => process.exit(0));
```

## Window Modes

Glimpse supports several window style flags that can be combined freely:

| Flag | Effect |
|------|--------|
| `frameless` | Removes the title bar — use your own HTML chrome |
| `floating` | Always on top of other windows |
| `transparent` | Clear window background — HTML body needs `background: transparent` |
| `clickThrough` | Window ignores all mouse events |
| `noDock` | No dock icon (macOS) — window works normally but the app doesn't appear in the dock or app switcher |

Common combinations:

- **Floating HUD**: `floating: true` — status panels, agent indicators
- **Custom dialog**: `frameless: true` — clean UI with no system chrome
- **Overlay**: `frameless + transparent` — shaped widgets that float over content
- **Companion widget**: `frameless + transparent + floating + clickThrough` — visual-only overlays that don't interfere with the desktop

## Follow Cursor

Attach a window to the cursor. Combined with `transparent + frameless + floating + clickThrough`, this creates visual companions that follow the mouse without interfering with normal usage.

```js
import { open } from 'glimpseui';

const win = open(`
  <body style="background: transparent; margin: 0;">
    <svg width="60" height="60" style="filter: drop-shadow(0 0 8px rgba(0,255,200,0.6));">
      <circle cx="30" cy="30" r="20" fill="none" stroke="cyan" stroke-width="2">
        <animateTransform attributeName="transform" type="rotate"
          from="0 30 30" to="360 30 30" dur="1s" repeatCount="indefinite"/>
      </circle>
    </svg>
  </body>
`, {
  width: 60, height: 60,
  transparent: true,
  frameless: true,
  followCursor: true,
  clickThrough: true,
  cursorOffset: { x: 20, y: -20 }
});
```

The window tracks the cursor in real-time across all screens. `followCursor` implies `floating` — the window stays on top automatically.

**Platform support:** Follow cursor works on macOS and Windows. On Linux with the native backend, it requires Hyprland (via IPC socket). The Chromium CDP backend also supports X11 (via `xdotool`). Other Wayland compositors without the Chromium backend will emit a warning and silently ignore `followCursor`.

You can also toggle tracking dynamically after the window is open:

```js
win.followCursor(false);                         // stop tracking
win.followCursor(true);                          // resume tracking (snap mode)
win.followCursor(true, undefined, 'spring');      // resume with spring physics
```

### Cursor Anchor Snap Points

Instead of raw pixel offsets, use `cursorAnchor` to position the window at one of 6 named snap points around the cursor:

```
     top-left    top-right
          \        /
   left -- 🖱️ -- right
          /        \
  bottom-left  bottom-right
```

A fixed **safe zone** is automatically applied so the window never overlaps the cursor graphic. `cursorOffset` can still be used on top of an anchor as a fine-tuning adjustment.

```js
// Window snaps to the right of the cursor with a safe gap
const win = open(html, {
  followCursor: true,
  cursorAnchor: 'top-right',
  transparent: true, frameless: true, clickThrough: true,
});

// Change anchor at runtime
win.followCursor(true, 'bottom-left');
```

## Menu Bar Mode (macOS only)

`statusItem()` creates a menu bar icon with a popover WebView — click the icon to show/hide your HTML content. The popover auto-closes when clicking outside.

```js
import { statusItem } from 'glimpseui';

const item = statusItem('<h1>Hello from the menu bar</h1>', {
  title: '👁',
  width: 300,
  height: 200,
});

item.on('click', () => console.log('popover toggled'));

// Dynamic updates
item.setTitle('🔴');
item.resize(400, 300);
```

CLI: `glimpse --status-item --title "👁" --width 300 --height 200`

Throws on Linux and Windows — menu bar mode is macOS-only.

## API Reference

### `open(html, options?)`

Opens a native window and returns a `GlimpseWindow`. The HTML is displayed once the WebView signals ready.

```js
import { open } from 'glimpseui';

const win = open('<html>...</html>', {
  width:  800,    // default: 800
  height: 600,    // default: 600
  title:  'App',  // default: "Glimpse"
});
```

**All options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `width` | number | `800` | Window width in pixels |
| `height` | number | `600` | Window height in pixels |
| `title` | string | `"Glimpse"` | Title bar text (ignored when frameless) |
| `x` | number | — | Horizontal screen position (omit to center) |
| `y` | number | — | Vertical screen position (omit to center) |
| `frameless` | boolean | `false` | Remove the title bar |
| `floating` | boolean | `false` | Always on top of other windows |
| `transparent` | boolean | `false` | Transparent window background |
| `clickThrough` | boolean | `false` | Window ignores all mouse events |
| `followCursor` | boolean | `false` | Track cursor position in real-time |
| `followMode` | string | `"snap"` | Follow animation: `snap` (instant) or `spring` (elastic with overshoot) |
| `cursorAnchor` | string | — | Snap point around cursor: `top-left`, `top-right`, `right`, `bottom-right`, `bottom-left`, `left` |
| `cursorOffset` | `{ x?, y? }` | `{ x: 20, y: -20 }` | Pixel offset from cursor (or fine-tuning on top of `cursorAnchor`) |
| `openLinks` | boolean | `false` | Open clicked `http`/`https` links in the system browser (macOS only) |
| `openLinksApp` | string | — | App bundle path for opening links, e.g. `"/Applications/Firefox.app"` (macOS only) |
| `hidden` | boolean | `false` | Start hidden (prewarm mode) — load HTML in the background, reveal with `win.show()` |
| `autoClose` | boolean | `false` | Close automatically after the first `message` event |
| `noDock` | boolean | `false` | No dock icon or app switcher entry (macOS) — window still receives focus and keyboard input |

### `statusItem(html, options?)` — macOS only

Creates a menu bar icon with a popover WebView. Returns a `GlimpseStatusItem` (extends `GlimpseWindow`).

```js
import { statusItem } from 'glimpseui';

const item = statusItem('<h1>Status</h1>', {
  title: '👁',     // menu bar icon/text
  width: 300,
  height: 200,
});
```

**Additional methods:**

- **`item.setTitle(title)`** — Update the menu bar label.
- **`item.resize(width, height)`** — Change the popover dimensions.

**Additional events:**

- **`click`** — Emitted when the user clicks the menu bar icon.

Throws `Error` on Linux and Windows.

### `prompt(html, options?)`

One-shot helper — opens a window, waits for the first message, then closes. Returns `Promise<data | null>` where `data` is the first message payload and `null` means the window was closed without sending.

```js
import { prompt } from 'glimpseui';

const answer = await prompt(`
  <h2>Delete this file?</h2>
  <button onclick="window.glimpse.send({ok: true})">Yes</button>
  <button onclick="window.glimpse.send({ok: false})">No</button>
`, { width: 300, height: 150, title: 'Confirm' });

if (answer?.ok) console.log('Deleted!');
```

Accepts the same `options` as `open()`. Optional `options.timeout` (ms) rejects the promise if no message arrives in time.

### `getNativeHostInfo()`

Returns the resolved native binary path and platform info:

```js
import { getNativeHostInfo } from 'glimpseui';

const host = getNativeHostInfo();
// { path: '/path/to/glimpse', platform: 'darwin', buildHint: "Run 'npm run build:macos'..." }
```

### `supportsFollowCursor()` / `getFollowCursorSupport()`

Runtime capability detection for follow-cursor:

```js
import { supportsFollowCursor, getFollowCursorSupport } from 'glimpseui';

if (supportsFollowCursor()) {
  // safe to use followCursor
} else {
  const { reason } = getFollowCursorSupport();
  console.warn(reason); // e.g. "Wayland follow-cursor is disabled without a compositor-specific backend"
}
```

### GlimpseWindow

`GlimpseWindow` extends `EventEmitter`.

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `ready` | `info: object` | WebView loaded — includes screen, appearance, and cursor info |
| `message` | `data: object` | Message sent from the page via `window.glimpse.send(data)` |
| `info` | `info: object` | Fresh system info (response to `.getInfo()`) |
| `click` | — | Menu bar icon clicked (status item mode only) |
| `closed` | — | Window was closed (by user or via `.close()`) |
| `error` | `Error` | Process error or malformed protocol line |

```js
win.on('ready', (info) => {
  console.log(info.screen);     // { width, height, scaleFactor, visibleWidth, visibleHeight, ... }
  console.log(info.appearance); // { darkMode, accentColor, reduceMotion, increaseContrast }
  console.log(info.cursor);     // { x, y }
  console.log(info.screens);    // [{ x, y, width, height, scaleFactor, ... }, ...]
  console.log(info.cursorTip);  // { x, y } in CSS coords (relative to window top-left), or null
});
win.on('message', (msg) => console.log('from page:', msg));
win.on('closed',  ()    => process.exit(0));
```

#### Methods

**`win.send(js)`** — Evaluate JavaScript in the WebView.
```js
win.send(`document.body.style.background = 'coral'`);
```

**`win.setHTML(html)`** — Replace the entire page content.
```js
win.setHTML('<html><body><h1>Step 2</h1></body></html>');
```

**`win.followCursor(enabled, anchor?, mode?)`** — Start or stop cursor tracking at runtime. Optional `anchor` sets the snap point. Optional `mode` sets the animation: `snap` or `spring`.
```js
win.followCursor(true);                        // attach to cursor
win.followCursor(true, 'top-right');           // attach at snap point
win.followCursor(true, 'top-right', 'spring'); // spring physics
win.followCursor(false);                       // detach
```

**`win.info`** — Getter for the last-known system info. Available after `ready`.
```js
const { width, height } = win.info.screen;
const isDark = win.info.appearance.darkMode;
```

**`win.getInfo()`** — Request fresh system info. Emits an `info` event.

**`win.loadFile(path)`** — Load a local HTML file by absolute path.

**`win.show(options?)`** — Reveal a hidden window. Optional `options.title` sets the window title.
```js
win.show();
win.show({ title: 'Results' });
```

**`win.close()`** — Close the window.

### JavaScript Bridge (in-page)

Every page loaded by Glimpse gets a `window.glimpse` object injected at document start:

```js
// Send any JSON-serializable value to Node.js → triggers 'message' event
window.glimpse.send({ action: 'submit', value: 42 });

// Close the window from inside the page
window.glimpse.close();

// Cursor tip position in CSS coordinates (px from window top-left)
// null when follow-cursor is not active
const tip = window.glimpse.cursorTip; // { x: 0, y: 120 } or null
```

## Protocol

Glimpse uses a newline-delimited JSON (JSON Lines) protocol over stdin/stdout. Each line is a complete JSON object. Any language that can spawn a process and pipe JSON can use Glimpse directly.

### Stdin → Glimpse (commands)

**Set HTML** — Replace page content. HTML must be base64-encoded.
```json
{"type":"html","html":"<base64-encoded HTML>"}
```

**Eval JavaScript** — Run JS in the WebView.
```json
{"type":"eval","js":"document.title = 'Updated'"}
```

**Follow Cursor** — Toggle cursor tracking. Optional `anchor` and `mode`.
```json
{"type":"follow-cursor","enabled":true}
{"type":"follow-cursor","enabled":true,"anchor":"top-right","mode":"spring"}
{"type":"follow-cursor","enabled":false}
```

**Load File** — Load a local HTML file by absolute path.
```json
{"type":"file","path":"/path/to/page.html"}
```

**Get Info** — Request current system info. Responds with an `info` event.
```json
{"type":"get-info"}
```

**Show** — Reveal a hidden window. Optional `title`.
```json
{"type":"show"}
{"type":"show","title":"Results"}
```

**Title** — Update menu bar text (status item mode only).
```json
{"type":"title","title":"🔴"}
```

**Resize** — Change popover dimensions (status item mode only).
```json
{"type":"resize","width":400,"height":300}
```

**Close** — Close the window and exit.
```json
{"type":"close"}
```

### Stdout → Host (events)

**Ready** — WebView finished loading. Includes system info.
```json
{"type":"ready","screen":{...},"screens":[...],"appearance":{...},"cursor":{...},"cursorTip":{...}}
```

**Info** — Response to `get-info`. Same shape as `ready`.
```json
{"type":"info","screen":{...},"screens":[...],"appearance":{...},"cursor":{...}}
```

**Message** — Data sent from the page via `window.glimpse.send(...)`.
```json
{"type":"message","data":{"action":"submit","value":42}}
```

**Click** — Menu bar icon clicked (status item mode only).
```json
{"type":"click"}
```

**Closed** — Window closed.
```json
{"type":"closed"}
```

Diagnostic logs are written to **stderr** (prefixed `[glimpse]`) and do not affect the protocol.

## CLI Usage

Drive the binary directly from any language — shell, Python, Ruby, etc.

```bash
# Basic usage
echo '{"type":"html","html":"PGh0bWw+PGJvZHk+SGVsbG8hPC9ib2R5PjwvaHRtbD4="}' \
  | ./src/glimpse --width 400 --height 300 --title "Hello"
```

**npx shortcut:**
```bash
echo '<h1>Hello</h1>' | npx glimpseui
npx glimpseui --demo
npx glimpseui page.html --frameless --transparent
```

**All flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--width N` | `800` | Window width in pixels |
| `--height N` | `600` | Window height in pixels |
| `--title STR` | `"Glimpse"` | Window title bar text |
| `--x N` | — | Horizontal screen position |
| `--y N` | — | Vertical screen position |
| `--frameless` | off | Remove the title bar |
| `--floating` | off | Always on top |
| `--transparent` | off | Transparent background |
| `--click-through` | off | Mouse passes through |
| `--follow-cursor` | off | Track cursor position |
| `--follow-mode MODE` | `snap` | `snap` (instant) or `spring` (elastic) |
| `--cursor-anchor POS` | — | Snap point: `top-left`, `top-right`, `right`, `bottom-right`, `bottom-left`, `left` |
| `--cursor-offset-x N` | `20` | Horizontal cursor offset |
| `--cursor-offset-y N` | `-20` | Vertical cursor offset |
| `--open-links` | off | Open `http`/`https` links in system browser (macOS) |
| `--open-links-app PATH` | — | Open links in a specific app (macOS) |
| `--status-item` | off | Menu bar mode instead of window (macOS) |
| `--hidden` | off | Start hidden (prewarm) |
| `--auto-close` | off | Exit after first message |
| `--no-dock` | off | No dock icon (macOS) |

**Shell example:**
```bash
HTML=$(echo '<html><body><h1>Hi</h1></body></html>' | base64)
{
  echo "{\"type\":\"html\",\"html\":\"$HTML\"}"
  cat  # keep stdin open
} | ./src/glimpse --width 600 --height 400
```

**Python example:**
```python
import subprocess, base64, json

html = b"<html><body><h1>Hello from Python</h1></body></html>"
proc = subprocess.Popen(
    ["./src/glimpse", "--width", "500", "--height", "400"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE
)

cmd = json.dumps({"type": "html", "html": base64.b64encode(html).decode()})
proc.stdin.write((cmd + "\n").encode())
proc.stdin.flush()

for line in proc.stdout:
    msg = json.loads(line)
    if msg["type"] == "ready":
        print("Window is ready")
    elif msg["type"] == "message":
        print("From page:", msg["data"])
    elif msg["type"] == "closed":
        break
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GLIMPSE_BINARY_PATH` | Override the native binary path (any platform) |
| `GLIMPSE_HOST_PATH` | Alias for `GLIMPSE_BINARY_PATH` |
| `GLIMPSE_BACKEND` | Linux only: `chromium` (force CDP backend) or `native` (force Rust/GTK binary) |

## Build from Source

### macOS

```bash
xcode-select --install      # one-time: install Xcode Command Line Tools
npm run build:macos          # or: swiftc -O src/glimpse.swift -o src/glimpse
```

### Linux

**Option A: Native backend (Rust + GTK4 + WebKitGTK)**

```bash
# Install dependencies (pick your distro)
# Fedora:  dnf install gtk4-devel webkitgtk6.0-devel gtk4-layer-shell-devel
# Ubuntu:  apt install libgtk-4-dev libwebkitgtk-6.0-dev libgtk4-layer-shell-dev
# Arch:    pacman -S gtk4 webkitgtk-6.0 gtk4-layer-shell

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh  # if no Rust toolchain
npm run build:linux
```

**Option B: Chromium CDP backend (zero-compile)**

No build step required — just needs a Chromium-based browser (Chrome, Chromium, Brave, Edge, etc.) installed on the system. If the native binary isn't built, Glimpse automatically falls back to the Chromium backend. You can also force it:

```bash
GLIMPSE_BACKEND=chromium node my-app.mjs  # force Chromium
GLIMPSE_BACKEND=native node my-app.mjs    # force native
```

The Chromium backend supports features the native Linux backend doesn't: follow-cursor on X11, system tray status items, and opening links externally.

### Windows

Requires [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) and Microsoft Edge WebView2 Runtime (pre-installed on Windows 10/11).

```bash
npm run build:windows
```

## Platform Notes

The core protocol and Node.js API are identical across platforms. Some features are platform-specific:

| Feature | macOS | Linux (native) | Linux (Chromium CDP) | Windows |
|---------|-------|----------------|---------------------|---------|
| Window modes (frameless, floating, transparent, click-through) | ✅ | ✅ | ✅ | ✅ |
| Follow cursor | ✅ | Hyprland only | Hyprland + X11 | ✅ |
| Spring physics (follow mode) | ✅ | ✅ (Hyprland) | ✅ | ✅ |
| Status item (menu bar / tray) | ✅ | — | ✅ | — |
| Open links externally | ✅ | — | ✅ | — |
| Hidden / prewarm | ✅ | ✅ | ✅ | ✅ |

## Performance

End-to-end benchmarks: spawn process → open native window → render HTML → JavaScript executes → response back to Node.js. Measured on Apple Silicon (M-series Mac).

| Scenario | Time |
|----------|------|
| Warm start (subsequent runs) | **~310ms** |
| First run after idle | ~630ms |
| Cold start (compile + run) | ~2,000ms |

Cold start only happens once during `npm install`. After that, it's always warm.

## Architecture

```
src/glimpse.swift              — macOS native binary (Swift/Cocoa/WebKit)
src/linux/                     — Linux native binary (Rust/GTK4/WebKitGTK)
src/chromium-backend.mjs       — Linux Chromium CDP backend (zero-compile alternative)
native/windows/Program.cs      — Windows native binary (.NET 8/WebView2)
src/glimpse.mjs                — Node.js wrapper (EventEmitter API)
src/follow-cursor-support.mjs  — Runtime capability detection
bin/glimpse.mjs                — CLI entry point (npx glimpseui)
scripts/build.mjs              — Unified cross-platform build
scripts/postinstall.mjs        — Platform-aware postinstall
```

## License

MIT

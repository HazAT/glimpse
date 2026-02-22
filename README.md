# Glimpse

Native macOS micro-UI for scripts and agents.

Glimpse opens a native WKWebView window in under 50ms and speaks a bidirectional JSON Lines protocol over stdin/stdout. No Electron, no browser, no runtime dependencies — just a tiny Swift binary and a Node.js wrapper.

## Requirements

- macOS (any recent version)
- Xcode Command Line Tools: `xcode-select --install`
- Node.js 18+

## Install

```bash
npm install glimpseui
```

`npm install` automatically compiles the Swift binary via a `postinstall` hook (~2 seconds). See [Compile on Install](#compile-on-install) for details.

**Manual build:**
```bash
npm run build
# or directly:
swiftc src/glimpse.swift -o src/glimpse
```

## Quick Start

```js
import { open } from 'glimpseui';

const win = open(`
  <html>
    <body style="font-family:sans-serif; padding:2rem;">
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

Common combinations:

- **Floating HUD**: `floating: true` — status panels, agent indicators
- **Custom dialog**: `frameless: true` — clean UI with no system chrome
- **Overlay**: `frameless + transparent` — shaped widgets that float over content
- **Companion widget**: `frameless + transparent + floating + clickThrough` — visual-only overlays that don't interfere with the desktop

## Follow Cursor

Attach a window to the cursor. Combined with `transparent + frameless + floating + clickThrough`, this creates visual companions that follow the mouse without interfering with normal usage.

```js
import { open } from './src/glimpse.mjs';

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

You can also toggle tracking dynamically after the window is open:

```js
win.followCursor(false); // stop tracking
win.followCursor(true);  // resume tracking
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

A fixed **safe zone** is automatically applied so the window never overlaps the cursor graphic (accounts for the largest macOS system cursors plus 8pt padding). `cursorOffset` can still be used on top of an anchor as a fine-tuning adjustment.

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

**Use cases:** animated SVG companions, agent "thinking" indicators, floating tooltips, custom cursor replacements.

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
| `cursorAnchor` | string | `null` | Snap point around cursor: `top-left`, `top-right`, `right`, `bottom-right`, `bottom-left`, `left`. Positions window with a safe zone gap; overrides raw offset positioning. |
| `cursorOffset` | `{ x?, y? }` | `{ x: 20, y: -20 }` | Pixel offset from cursor (or fine-tuning on top of `cursorAnchor`) |
| `autoClose` | boolean | `false` | Close the window automatically after the first `message` event |

### `prompt(html, options?)`

One-shot helper — opens a window, waits for the first message, then closes it automatically. Returns a `Promise<data | null>` where `data` is the first message payload and `null` means the user closed the window without sending anything.

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

### GlimpseWindow

`GlimpseWindow` extends `EventEmitter`.

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `ready` | `info: object` | WebView loaded — includes screen, appearance, and cursor info |
| `message` | `data: object` | Message sent from the page via `window.glimpse.send(data)` |
| `info` | `info: object` | Fresh system info (response to `.getInfo()`) |
| `closed` | — | Window was closed (by user or via `.close()`) |
| `error` | `Error` | Process error or malformed protocol line |

```js
win.on('ready', (info) => {
  console.log(info.screen);     // { width, height, scaleFactor, visibleWidth, visibleHeight, ... }
  console.log(info.appearance); // { darkMode, accentColor, reduceMotion, increaseContrast }
  console.log(info.cursor);     // { x, y }
  console.log(info.screens);    // [{ x, y, width, height, scaleFactor, ... }, ...]
  console.log(info.cursorTip);  // { x, y } in CSS coords (relative to window top-left), or null when not following
});
win.on('message', (msg) => console.log('from page:', msg));
win.on('closed',  ()    => process.exit(0));
win.on('error',   (err) => console.error(err));
```

#### Methods

**`win.send(js)`** — Evaluate JavaScript in the WebView.
```js
win.send(`document.body.style.background = 'coral'`);
win.send(`document.getElementById('status').textContent = 'Done'`);
```

**`win.setHTML(html)`** — Replace the entire page content.
```js
win.setHTML('<html><body><h1>Step 2</h1></body></html>');
```

**`win.followCursor(enabled, anchor?)`** — Start or stop cursor tracking at runtime. Optional `anchor` sets the snap point (`top-left`, `top-right`, `right`, `bottom-right`, `bottom-left`, `left`).
```js
win.followCursor(true);              // attach to cursor (uses offset)
win.followCursor(true, 'top-right'); // attach at top-right snap point
win.followCursor(false);             // detach
```

**`win.info`** — Getter for the last-known system info (screen, appearance, cursor). Available after `ready`.
```js
const { width, height } = win.info.screen;
const isDark = win.info.appearance.darkMode;
```

**`win.getInfo()`** — Request fresh system info. Emits an `info` event with updated data.
```js
win.getInfo();
win.on('info', (info) => console.log(info.appearance.darkMode));
```

**`win.loadFile(path)`** — Load a local HTML file into the WebView by absolute path.
```js
win.loadFile('/path/to/page.html');
```

**`win.close()`** — Close the window programmatically.
```js
win.close();
```

### JavaScript Bridge (in-page)

Every page loaded by Glimpse gets a `window.glimpse` object injected at document start:

```js
// Send any JSON-serializable value to Node.js → triggers 'message' event
window.glimpse.send({ action: 'submit', value: 42 });

// Close the window from inside the page
window.glimpse.close();

// Cursor tip position in CSS coordinates (px from window top-left, Y down)
// null when follow-cursor is not active; updated on window resize
const tip = window.glimpse.cursorTip; // { x: 0, y: 120 } or null
```

## Protocol

Glimpse uses a newline-delimited JSON (JSON Lines) protocol. Each line is a complete JSON object. This makes it easy to drive the binary from any language.

### Stdin → Glimpse (commands)

**Set HTML** — Replace page content. HTML must be base64-encoded.
```json
{"type":"html","html":"<base64-encoded HTML>"}
```

**Eval JavaScript** — Run JS in the WebView.
```json
{"type":"eval","js":"document.title = 'Updated'"}
```

**Follow Cursor** — Toggle cursor tracking at runtime. Optional `anchor` sets the snap point.
```json
{"type":"follow-cursor","enabled":true}
{"type":"follow-cursor","enabled":true,"anchor":"top-right"}
{"type":"follow-cursor","enabled":false}
```

**Load File** — Load a local HTML file by absolute path.
```json
{"type":"file","path":"/path/to/page.html"}
```

**Get Info** — Request current system info (screen, appearance, cursor). Responds with an `info` event.
```json
{"type":"get-info"}
```

**Close** — Close the window and exit.
```json
{"type":"close"}
```

### Stdout → Host (events)

**Ready** — WebView finished loading. Includes system info.
```json
{"type":"ready","screen":{"width":2560,"height":1440,"scaleFactor":2,"visibleX":0,"visibleY":48,"visibleWidth":2560,"visibleHeight":1367},"screens":[...],"appearance":{"darkMode":true,"accentColor":"#007AFF","reduceMotion":false,"increaseContrast":false},"cursor":{"x":500,"y":800},"cursorTip":{"x":0,"y":120}}
```

`cursorTip` is present when follow-cursor is active. It holds the cursor tip position in CSS coordinates (px from window top-left, Y increases downward). `null` otherwise.

**Info** — Response to a `get-info` command. Same shape as `ready` but with `type: "info"`.
```json
{"type":"info","screen":{...},"screens":[...],"appearance":{...},"cursor":{...},"cursorTip":{"x":0,"y":120}}
```

**Message** — Data sent from the page via `window.glimpse.send(...)`.
```json
{"type":"message","data":{"action":"submit","value":42}}
```

**Closed** — Window closed (by user or via close command).
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

Available flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--width N` | `800` | Window width in pixels |
| `--height N` | `600` | Window height in pixels |
| `--title STR` | `"Glimpse"` | Window title bar text |
| `--x N` | — | Horizontal screen position (omit to center) |
| `--y N` | — | Vertical screen position (omit to center) |
| `--frameless` | off | Remove the title bar |
| `--floating` | off | Always on top of other windows |
| `--transparent` | off | Transparent window background |
| `--click-through` | off | Window ignores all mouse events |
| `--follow-cursor` | off | Track cursor position in real-time |
| `--cursor-anchor <position>` | — | Snap point around cursor: `top-left`, `top-right`, `right`, `bottom-right`, `bottom-left`, `left` |
| `--cursor-offset-x N` | `20` | Horizontal offset from cursor (or fine-tuning on top of `--cursor-anchor`) |
| `--cursor-offset-y N` | `-20` | Vertical offset from cursor (or fine-tuning on top of `--cursor-anchor`) |
| `--auto-close` | off | Exit after receiving the first message from the page |

**Shell example — encode HTML and pipe it in:**
```bash
HTML=$(echo '<html><body><h1>Hi</h1></body></html>' | base64)
{
  echo "{\"type\":\"html\",\"html\":\"$HTML\"}"
  cat  # keep stdin open so the window stays up
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

## Compile on Install

Every Mac ships with `swiftc` once Xcode Command Line Tools are installed — no Xcode IDE required. Glimpse takes advantage of this: running `npm install` triggers a `postinstall` script that compiles `src/glimpse.swift` into a native binary in about 2 seconds.

```
> glimpse@0.1.0 postinstall
> npm run build

swiftc src/glimpse.swift -o src/glimpse  ✓
```

**If compilation fails**, the most common cause is missing Xcode CLT:
```bash
xcode-select --install
```

To recompile manually at any time:
```bash
npm run build
```

## License

MIT

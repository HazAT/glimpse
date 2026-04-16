---
name: glimpse
description: Show native UI from scripts and agents — dialogs, forms, visualizations, floating widgets, cursor companions. Supports macOS, Linux, and Windows. Use when you need to display HTML to the user, collect input, show a chart, render markdown, or create any visual interaction without a browser.
---

# Glimpse — Native Micro-UI

Glimpse opens a native window with a webview in under 50ms. You write HTML, the user sees it instantly. Bidirectional communication via `window.glimpse.send()` (webview → Node) and `.send(js)` (Node → webview). Works on macOS (WKWebView), Linux (WebKitGTK), and Windows (WebView2).

**When to use Glimpse:**
- You need user input beyond yes/no (forms, selections, text input)
- You want to show something visual (charts, markdown, images, diffs)
- You want to confirm a destructive action with a proper dialog
- You want a floating indicator, notification, or companion widget
- You need the user to interact with rich content

**Import:** Always use the absolute path to `glimpse.mjs` within the installed package — the bare `'glimpseui'` specifier fails when scripts run from `/tmp` or anywhere without `node_modules`. Resolve `../../src/glimpse.mjs` relative to this skill file's directory.

On **macOS/Linux**, use a direct path:
```js
import { open, prompt } from '<RESOLVED_PATH>/src/glimpse.mjs';
```

On **Windows**, ESM imports require a `file:///` URL:
```js
import { open, prompt } from 'file:///<RESOLVED_PATH>/src/glimpse.mjs';
// e.g. import { open, prompt } from 'file:///C:/Users/me/.pi/agent/.../glimpseui/src/glimpse.mjs';
```

---

## Quick Reference

### One-Shot Dialog (prompt)
```js
import { prompt } from '<RESOLVED_PATH>/src/glimpse.mjs';

const answer = await prompt(html, {
  width: 400, height: 300,    // window size
  title: 'My Dialog',         // title bar text
  frameless: true,             // no title bar
  transparent: true,           // see-through background
});
// answer = data from window.glimpse.send(), or null if user closed window
```

### Persistent Window (open)
```js
import { open } from '<RESOLVED_PATH>/src/glimpse.mjs';

const win = open(html, options);
win.on('ready', (info) => {});       // HTML loaded — info has screen, appearance, cursor
win.on('message', data => {});       // user interaction
win.on('info', info => {});          // fresh system info (after getInfo())
win.on('closed', () => {});          // window gone
win.send('document.title = "Hi"');   // eval JS in webview
win.setHTML('<h1>New content</h1>'); // replace HTML
win.info;                            // last-known system info
win.getInfo();                       // request fresh info
win.close();                         // close window
```

### All Options
```js
{
  width, height,          // pixels (default: 800×600)
  title,                  // window title (default: "Glimpse")
  frameless: true,        // no title bar, draggable by background
  floating: true,         // always on top
  transparent: true,      // transparent window background
  clickThrough: true,     // mouse passes through window
  followCursor: true,     // window follows mouse cursor
  followMode: 'spring',  // 'snap' (instant, default) or 'spring' (elastic)
  cursorAnchor: 'top-right', // snap point: top-left, top-right, right, bottom-right, bottom-left, left
  cursorOffset: {x, y},   // offset from cursor (default: 20, -20)
  openLinks: true,        // open clicked http/https links in default browser
  openLinksApp: '/Applications/Google Chrome.app', // optional app bundle path
  autoClose: true,        // close after first message
  noDock: true,           // no dock icon or app switcher entry (macOS)
  x, y,                   // exact screen position
  timeout,                // for prompt() only — ms before rejecting
}
```

### System Info (available on ready)
```js
win.on('ready', (info) => {
  // Screen
  info.screen.width          // 2560 (full resolution)
  info.screen.height         // 1440
  info.screen.scaleFactor    // 2 (Retina)
  info.screen.visibleWidth   // 2560 (excluding dock)
  info.screen.visibleHeight  // 1367 (excluding menu bar)

  // Appearance
  info.appearance.darkMode         // true
  info.appearance.accentColor      // "#007AFF"
  info.appearance.reduceMotion     // false
  info.appearance.increaseContrast // false

  // Cursor
  info.cursor.x   // 500
  info.cursor.y   // 800

  // All monitors
  info.screens    // [{ x, y, width, height, scaleFactor, ... }, ...]
});

// Access anytime after ready:
win.info.screen.width
win.info.appearance.darkMode
```

### In-Page JavaScript Bridge
```js
window.glimpse.send(data)  // send data to Node (any JSON-serializable value)
window.glimpse.close()     // close the window from JS
```

---

## Patterns

### 1. Confirm Dialog
The simplest use case. Ask yes/no, get the answer, move on.

```js
const answer = await prompt(`
<body style="font-family: system-ui; padding: 24px; background: white;">
  <h2 style="margin-top: 0;">Delete 47 files?</h2>
  <p style="color: #666;">This cannot be undone.</p>
  <div style="display: flex; gap: 8px; justify-content: flex-end;">
    <button onclick="window.glimpse.send({ok: false})"
      style="padding: 10px 20px; font-size: 14px; border: 1px solid #ddd; border-radius: 8px; background: white; cursor: pointer;">
      Cancel
    </button>
    <button onclick="window.glimpse.send({ok: true})" autofocus
      style="padding: 10px 20px; font-size: 14px; border: none; border-radius: 8px; background: #e53e3e; color: white; cursor: pointer;">
      Delete
    </button>
  </div>
  <script>
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') window.glimpse.send({ok: false});
      if (e.key === 'Enter') window.glimpse.send({ok: true});
    });
  </script>
</body>
`, { width: 340, height: 180, title: 'Confirm' });

if (answer?.ok) { /* proceed with deletion */ }
```

### 2. Text Input Form
Collect structured input. Enter submits, Escape cancels.

```js
const result = await prompt(`
<body style="font-family: system-ui; padding: 24px; background: white;">
  <style>
    input, select { padding: 8px 12px; font-size: 14px; border: 1px solid #ddd; border-radius: 6px; width: 100%; margin-bottom: 12px; }
    input:focus, select:focus { outline: none; border-color: #4299e1; box-shadow: 0 0 0 3px rgba(66,153,225,0.15); }
    button { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; }
  </style>
  <h3 style="margin-top: 0;">New Component</h3>
  <input id="name" placeholder="Component name" autofocus />
  <select id="type">
    <option value="page">Page</option>
    <option value="component">Component</option>
    <option value="layout">Layout</option>
  </select>
  <div style="display: flex; gap: 8px; justify-content: flex-end;">
    <button onclick="window.glimpse.send(null)" style="background: #eee;">Cancel</button>
    <button onclick="submit()" style="background: #4299e1; color: white;">Create</button>
  </div>
  <script>
    function submit() {
      window.glimpse.send({
        name: document.getElementById('name').value,
        type: document.getElementById('type').value,
      });
    }
    document.getElementById('name').addEventListener('keydown', e => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') window.glimpse.send(null);
    });
  </script>
</body>
`, { width: 380, height: 260, title: 'Create' });

if (result) console.log(`Creating ${result.type}: ${result.name}`);
```

### 3. Selection List
Pick from a list of options. Click or use arrow keys + Enter.

```js
function pickFromList(title, items) {
  const itemsHTML = items.map((item, i) =>
    `<div class="item${i === 0 ? ' selected' : ''}" data-index="${i}" onclick="pick(${i})">${item}</div>`
  ).join('');

  return prompt(`
  <body style="font-family: system-ui; margin: 0; background: white;">
    <style>
      .header { padding: 12px 16px; font-size: 13px; color: #888; border-bottom: 1px solid #eee; }
      .item { padding: 10px 16px; cursor: pointer; font-size: 14px; }
      .item:hover, .item.selected { background: #4299e1; color: white; }
    </style>
    <div class="header">${title}</div>
    <div id="list">${itemsHTML}</div>
    <script>
      const items = document.querySelectorAll('.item');
      let sel = 0;
      function pick(i) { window.glimpse.send({index: i, value: items[i].textContent}); }
      document.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { items[sel].classList.remove('selected'); sel = (sel+1) % items.length; items[sel].classList.add('selected'); }
        if (e.key === 'ArrowUp') { items[sel].classList.remove('selected'); sel = (sel-1+items.length) % items.length; items[sel].classList.add('selected'); }
        if (e.key === 'Enter') pick(sel);
        if (e.key === 'Escape') window.glimpse.send(null);
        e.preventDefault();
      });
    </script>
  </body>
  `, { width: 300, height: 40 + items.length * 38, frameless: true });
}

const choice = await pickFromList('Pick a framework', ['React', 'Vue', 'Svelte', 'Solid', 'Angular']);
```

### 4. Markdown / Rich Content Viewer
Show formatted content. Useful for previewing generated docs, READMEs, or diffs.

```js
// Render markdown with a CDN library
const markdown = `# Hello World\n\nThis is **bold** and this is \`code\`.`;

const win = open(`
<body style="font-family: system-ui; padding: 24px; background: white;">
  <div id="content"></div>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script>
    document.getElementById('content').innerHTML = marked.parse(${JSON.stringify(markdown)});
  </script>
</body>
`, { width: 600, height: 400, title: 'Preview' });
```

### 5. Live Progress / Streaming Output
Push updates into the window as work progresses.

```js
const win = open(`
<body style="font-family: monospace; padding: 16px; background: #1a1a2e; color: #0f0; font-size: 13px;">
  <div id="log" style="white-space: pre-wrap;"></div>
  <script>
    window.appendLog = (text) => {
      document.getElementById('log').textContent += text + '\\n';
      window.scrollTo(0, document.body.scrollHeight);
    };
  </script>
</body>
`, { width: 500, height: 300, title: 'Build Progress' });

win.on('ready', () => {
  win.send(`appendLog('Starting build...')`);
  // As your process runs, push updates:
  win.send(`appendLog('✓ Compiled 42 files')`);
  win.send(`appendLog('✓ Tests passed')`);
  win.send(`appendLog('✓ Done!')`);
});
```

### 6. Adaptive Dark/Light Mode
Use system info to style the UI to match the user's appearance.

```js
const win = open('', { width: 400, height: 200 });

win.on('ready', ({ appearance, screen }) => {
  const bg = appearance.darkMode ? '#1a1a2e' : '#ffffff';
  const fg = appearance.darkMode ? '#ffffff' : '#333333';
  const accent = appearance.accentColor;

  win.setHTML(`
    <body style="font-family: system-ui; padding: 24px; background: ${bg}; color: ${fg};">
      <h2 style="color: ${accent};">Adaptive UI</h2>
      <p>Dark mode: ${appearance.darkMode ? 'on' : 'off'}</p>
      <p>Screen: ${screen.width}×${screen.height} @${screen.scaleFactor}x</p>
      <button onclick="window.glimpse.close()"
        style="padding: 8px 16px; background: ${accent}; color: white; border: none; border-radius: 6px; cursor: pointer;">
        Close
      </button>
    </body>
  `);
});
```

### 7. Floating Notification
A brief, auto-dismissing toast. No interaction needed.

```js
function notify(message, durationMs = 3000) {
  const win = open(`
  <body style="margin: 0; background: transparent !important;">
    <div style="
      background: rgba(0,0,0,0.85); color: white; padding: 12px 20px;
      border-radius: 10px; font-family: system-ui; font-size: 14px;
      backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    ">${message}</div>
  </body>
  `, { width: 300, height: 60, frameless: true, transparent: true, floating: true, clickThrough: true });

  win.on('ready', () => setTimeout(() => win.close(), durationMs));
}

notify('✅ Deployed to production');
```

### 8. Cursor Companion
A visual element that follows the cursor. Great for agent status indicators.

```js
// Spinning ring that follows the cursor
const win = open(`
<body style="background: transparent !important; margin: 0;">
  <svg width="50" height="50" style="filter: drop-shadow(0 0 6px rgba(0,255,200,0.5));">
    <circle cx="25" cy="25" r="18" fill="none" stroke="cyan" stroke-width="2" stroke-dasharray="20 60">
      <animateTransform attributeName="transform" type="rotate"
        from="0 25 25" to="360 25 25" dur="0.8s" repeatCount="indefinite"/>
    </circle>
  </svg>
</body>
`, {
  width: 50, height: 50,
  transparent: true, frameless: true,
  followCursor: true, clickThrough: true,
  cursorOffset: { x: 20, y: -20 },
});

// Stop following after 10 seconds
setTimeout(() => win.close(), 10_000);
```

### 9. Agent Thinking Indicator
Show a pulsing indicator while the agent is processing. Disappears when done.

```js
function showThinking() {
  const win = open(`
  <body style="background: transparent !important; margin: 0;">
    <div style="
      display: flex; align-items: center; gap: 8px; padding: 8px 16px;
      background: rgba(0,0,0,0.8); border-radius: 20px;
      backdrop-filter: blur(10px); font-family: system-ui; color: white; font-size: 13px;
    ">
      <div style="width: 8px; height: 8px; border-radius: 50%; background: #ffd700; animation: pulse 1s ease-in-out infinite;"></div>
      Thinking...
    </div>
    <style>@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }</style>
  </body>
  `, { width: 140, height: 40, frameless: true, transparent: true, floating: true, clickThrough: true });

  return () => win.close(); // Returns a stop function
}

const stopThinking = showThinking();
// ... do work ...
stopThinking();
```

### 10. Image / Chart Display
Show a generated chart or image.

```js
// Using Chart.js from CDN
const win = open(`
<body style="margin: 0; background: white;">
  <canvas id="chart"></canvas>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    new Chart(document.getElementById('chart'), {
      type: 'bar',
      data: {
        labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        datasets: [{ label: 'Commits', data: [12, 19, 3, 5, 8], backgroundColor: '#4299e1' }]
      }
    });
  </script>
</body>
`, { width: 500, height: 350, title: 'Weekly Commits' });
```

### 11. Frosted Glass Command Palette
A frameless, transparent search/command palette.

```js
const result = await prompt(`
<body style="margin: 0; background: transparent !important;">
  <style>
    .palette {
      background: rgba(30,30,40,0.9); border-radius: 12px; overflow: hidden;
      backdrop-filter: blur(30px); -webkit-backdrop-filter: blur(30px);
      border: 1px solid rgba(255,255,255,0.1); font-family: system-ui;
    }
    input {
      width: 100%; padding: 16px 20px; font-size: 16px; border: none;
      background: transparent; color: white; outline: none;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    input::placeholder { color: #666; }
    .results { max-height: 200px; overflow-y: auto; }
    .result {
      padding: 10px 20px; color: #ccc; cursor: pointer; display: flex;
      justify-content: space-between; font-size: 14px;
    }
    .result:hover, .result.active { background: rgba(66,153,225,0.3); color: white; }
    .result .hint { color: #666; font-size: 12px; }
  </style>
  <div class="palette">
    <input id="q" placeholder="Type a command..." autofocus />
    <div class="results" id="results"></div>
  </div>
  <script>
    const commands = [
      {name: 'New File', hint: '⌘N'},
      {name: 'Open Terminal', hint: '⌘T'},
      {name: 'Run Tests', hint: '⌘R'},
      {name: 'Git Commit', hint: '⌘K'},
      {name: 'Search Files', hint: '⌘P'},
    ];
    let filtered = [...commands], active = 0;
    function render() {
      document.getElementById('results').innerHTML = filtered.map((c, i) =>
        '<div class="result' + (i===active?' active':'') + '" onclick="pick('+i+')">' +
        c.name + '<span class="hint">' + c.hint + '</span></div>'
      ).join('');
    }
    function pick(i) { window.glimpse.send(filtered[i]); }
    document.getElementById('q').addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      filtered = commands.filter(c => c.name.toLowerCase().includes(q));
      active = 0; render();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { active = (active+1) % filtered.length; render(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { active = (active-1+filtered.length) % filtered.length; render(); e.preventDefault(); }
      if (e.key === 'Enter' && filtered.length) pick(active);
      if (e.key === 'Escape') window.glimpse.send(null);
    });
    render();
  </script>
</body>
`, { width: 400, height: 300, frameless: true, transparent: true });
```

---

## Creative Ideas

Things you can build with Glimpse that you might not have considered (use `win.info` for screen dimensions and dark mode):

- **Diff viewer** — Show a side-by-side diff of changes before committing
- **Color picker** — HTML color input + preview, return the hex value
- **File browser** — List files with icons, let user click to select
- **Approval flow** — Show generated code in a syntax-highlighted view, user approves or rejects
- **Multi-step wizard** — Use `.setHTML()` to swap content between steps, one window
- **Screenshot annotation** — Load an image, let user draw/click to mark areas
- **Kanban board** — Drag-and-drop task management for todos
- **Terminal overlay** — Transparent floating terminal output on top of the user's work
- **Music player** — Floating mini player with album art
- **System monitor** — Tiny floating CPU/memory widget using `.send()` to push updates
- **Emoji picker** — Grid of emojis, click to select, return the character
- **Pomodoro timer** — Floating transparent countdown timer
- **Fullscreen overlay** — Use `win.info.screen` for exact dimensions, `frameless + transparent`
- **Adaptive theming** — Read `win.info.appearance.darkMode` and style to match the OS
- **Multi-monitor aware** — Use `win.info.screens` to position windows on specific displays

---

## Tips

- **Always set `cursor: pointer`** on clickable elements
- **Use `autofocus`** on the primary input field
- **Add keyboard shortcuts** — Enter to confirm, Escape to cancel
- **For transparent windows**, set `background: transparent !important` on `<body>` and use a styled container with `border-radius` for rounded corners
- **Backdrop blur** (`backdrop-filter: blur(20px)`) makes transparent windows look native and polished
- **`.send()` accepts any JS** — use it to push live data into the webview (progress, streaming text, state changes)
- **`prompt()` returns `null`** when the user closes without sending — always handle this case
- **Be generous with window height** — Content clips without scrollbars if the window is too short. Add 20–30% more height than you think you need. Padding, margins, and button rows add up fast. A form with 2 inputs + buttons needs ~300px minimum, not 200px
- **Keep windows small** — Glimpse is for focused interactions, not full apps

### Windows-Specific Tips

- **Use `file:///` for ESM imports** — On Windows, Node.js ESM requires `file:///C:/...` URLs for absolute paths. Bare paths like `C:/...` fail with `ERR_UNSUPPORTED_ESM_URL_SCHEME`
- **Use `addEventListener` instead of inline `onclick`** — Inline event handlers (`onclick="..."`) can be unreliable in WebView2. Always use `document.getElementById('x').addEventListener('click', fn)` instead
- **Use `floating: true` for sequential prompts** — When opening multiple `prompt()` calls in sequence, subsequent windows may appear behind other windows. Setting `floating: true` ensures they stay on top

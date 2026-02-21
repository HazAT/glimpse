#!/usr/bin/env node

import { open } from '../src/glimpse.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);

// Parse flags and collect positional args
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') { flags.help = true; }
  else if (arg === '--demo') { flags.demo = true; }
  else if (arg === '--frameless') { flags.frameless = true; }
  else if (arg === '--floating') { flags.floating = true; }
  else if (arg === '--transparent') { flags.transparent = true; }
  else if (arg === '--click-through') { flags.clickThrough = true; }
  else if (arg === '--follow-cursor') { flags.followCursor = true; }
  else if (arg === '--auto-close') { flags.autoClose = true; }
  else if (arg === '--width' && args[i + 1]) { flags.width = parseInt(args[++i]); }
  else if (arg === '--height' && args[i + 1]) { flags.height = parseInt(args[++i]); }
  else if (arg === '--title' && args[i + 1]) { flags.title = args[++i]; }
  else if (arg === '--x' && args[i + 1]) { flags.x = parseInt(args[++i]); }
  else if (arg === '--y' && args[i + 1]) { flags.y = parseInt(args[++i]); }
  else if (arg === '--cursor-offset-x' && args[i + 1]) { flags.cursorOffset = { ...flags.cursorOffset, x: parseInt(args[++i]) }; }
  else if (arg === '--cursor-offset-y' && args[i + 1]) { flags.cursorOffset = { ...flags.cursorOffset, y: parseInt(args[++i]) }; }
  else if (!arg.startsWith('-')) { positional.push(arg); }
  else { console.error(`Unknown flag: ${arg}`); process.exit(1); }
}

if (flags.help) {
  console.log(`
glimpseui — Native macOS micro-UI for scripts and agents

Usage:
  glimpseui [options] [file.html]    Open an HTML file
  echo '<h1>Hi</h1>' | glimpseui    Pipe HTML from stdin
  glimpseui --demo                   Show a demo window

Options:
  --width <n>          Window width (default: 800)
  --height <n>         Window height (default: 600)
  --title <text>       Window title (default: "Glimpse")
  --frameless          No title bar
  --floating           Always on top
  --transparent        Transparent background
  --click-through      Mouse passes through
  --follow-cursor      Window follows cursor
  --cursor-offset-x <n>  Cursor X offset (default: 20)
  --cursor-offset-y <n>  Cursor Y offset (default: -20)
  --auto-close         Close after first window.glimpse.send()
  --x <n>              Window X position
  --y <n>              Window Y position
  --demo               Show a demo window
  --help, -h           Show this help
`);
  process.exit(0);
}

const DEMO_HTML = `
<body style="margin: 0; font-family: system-ui; background: transparent !important;">
  <style>
    .container {
      padding: 32px; height: 100vh; box-sizing: border-box;
      background: rgba(20, 20, 35, 0.9); backdrop-filter: blur(30px); -webkit-backdrop-filter: blur(30px);
      border-radius: 16px; border: 1px solid rgba(255,255,255,0.1);
      display: flex; flex-direction: column; gap: 16px;
    }
    h1 { margin: 0; font-size: 22px; color: white; }
    h1 span { background: linear-gradient(135deg, #e94560, #4299e1); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    p { margin: 0; color: #888; font-size: 14px; line-height: 1.5; }
    code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #ccc; }
    .buttons { display: flex; gap: 10px; margin-top: auto; }
    button {
      flex: 1; padding: 12px; font-size: 14px; font-weight: 600; border: none;
      border-radius: 10px; cursor: pointer; transition: all 0.15s;
    }
    button:hover { transform: scale(1.03); }
    button:active { transform: scale(0.97); }
    .primary { background: linear-gradient(135deg, #e94560, #c23152); color: white; }
    .primary:hover { box-shadow: 0 0 20px rgba(233,69,96,0.4); }
    .secondary { background: rgba(255,255,255,0.1); color: #ccc; }
    .secondary:hover { background: rgba(255,255,255,0.15); }
    .features { display: flex; flex-wrap: wrap; gap: 6px; }
    .tag { background: rgba(66,153,225,0.15); color: #4299e1; padding: 4px 10px; border-radius: 6px; font-size: 12px; }
  </style>
  <div class="container">
    <h1>👁️ <span>Glimpse</span></h1>
    <p>Native macOS micro-UI. Sub-50ms windows with WKWebView.<br>
       Bidirectional communication via <code>window.glimpse.send()</code></p>
    <div class="features">
      <span class="tag">Frameless</span>
      <span class="tag">Transparent</span>
      <span class="tag">Floating</span>
      <span class="tag">Follow Cursor</span>
      <span class="tag">Keyboard</span>
      <span class="tag">Auto-close</span>
    </div>
    <div class="buttons">
      <button class="secondary" onclick="window.glimpse.close()">✕ Close</button>
      <button class="primary" onclick="window.glimpse.close()">🚀 Cool!</button>
    </div>
  </div>
  <script>
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' || e.key === 'Enter') window.glimpse.close();
    });
  </script>
</body>`;

async function main() {
  let html;

  if (flags.demo) {
    html = DEMO_HTML;
    flags.frameless = flags.frameless ?? true;
    flags.transparent = flags.transparent ?? true;
    flags.width = flags.width ?? 380;
    flags.height = flags.height ?? 320;
  } else if (positional.length > 0) {
    // Load from file
    const file = resolve(positional[0]);
    if (!existsSync(file)) {
      console.error(`File not found: ${file}`);
      process.exit(1);
    }
    html = readFileSync(file, 'utf-8');
  } else if (!process.stdin.isTTY) {
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    html = Buffer.concat(chunks).toString('utf-8');
  } else {
    console.error('Usage: glimpseui [options] [file.html]');
    console.error('       echo "<h1>Hi</h1>" | glimpseui');
    console.error('       glimpseui --demo');
    console.error('');
    console.error('Run glimpseui --help for all options.');
    process.exit(1);
  }

  const win = open(html, flags);

  win.on('message', data => {
    console.log(JSON.stringify(data));
  });

  win.on('closed', () => {
    process.exit(0);
  });
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

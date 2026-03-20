#!/usr/bin/env node

/**
 * Glimpse Chromium Backend
 *
 * Drop-in replacement for the native binary on Linux. Speaks the same
 * Glimpse JSON Lines protocol on stdin/stdout, but uses system Chromium
 * via CDP (Chrome DevTools Protocol) over pipe instead of WebKitGTK.
 *
 * Usage: node chromium-backend.mjs [--width 800] [--height 600] [--frameless] ...
 */

import { spawn, execSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[glimpse] ${msg}\n`);
}

function emitEvent(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ── CLI Parsing ─────────────────────────────────────────────────────────────

function parseArgs() {
  const config = {
    width: 800,
    height: 600,
    title: 'Glimpse',
    frameless: false,
    floating: false,
    transparent: false,
    clickThrough: false,
    followCursor: false,
    followMode: 'snap',
    cursorAnchor: null,
    cursorOffsetX: null,
    cursorOffsetY: null,
    x: null,
    y: null,
    hidden: false,
    autoClose: false,
    openLinks: false,
    openLinksApp: null,
    statusItem: false,
  };

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--width':       config.width = parseInt(args[++i]) || 800; break;
      case '--height':      config.height = parseInt(args[++i]) || 600; break;
      case '--title':       config.title = args[++i] || 'Glimpse'; break;
      case '--x':           config.x = parseInt(args[++i]); break;
      case '--y':           config.y = parseInt(args[++i]); break;
      case '--frameless':   config.frameless = true; break;
      case '--floating':    config.floating = true; break;
      case '--transparent': config.transparent = true; break;
      case '--click-through': config.clickThrough = true; break;
      case '--follow-cursor': config.followCursor = true; break;
      case '--follow-mode': config.followMode = args[++i] || 'snap'; break;
      case '--cursor-anchor': config.cursorAnchor = args[++i] || null; break;
      case '--cursor-offset-x': config.cursorOffsetX = parseInt(args[++i]); break;
      case '--cursor-offset-y': config.cursorOffsetY = parseInt(args[++i]); break;
      case '--hidden':      config.hidden = true; break;
      case '--auto-close':  config.autoClose = true; break;
      case '--open-links':  config.openLinks = true; break;
      case '--open-links-app': config.openLinks = true; config.openLinksApp = args[++i]; break;
      case '--status-item': config.statusItem = true; break;
    }
  }

  // Default offsets: 20/-20 for offset-only, 0/0 when anchor is set
  if (config.cursorOffsetX == null) config.cursorOffsetX = config.cursorAnchor ? 0 : 20;
  if (config.cursorOffsetY == null) config.cursorOffsetY = config.cursorAnchor ? 0 : -20;

  return config;
}

// ── Chrome Discovery ────────────────────────────────────────────────────────

function findChrome() {
  if (process.env.GLIMPSE_CHROME_PATH) return process.env.GLIMPSE_CHROME_PATH;

  const candidates = [
    'chromium',
    'chromium-browser',
    'google-chrome-stable',
    'google-chrome',
    'chrome',
  ];

  for (const name of candidates) {
    try {
      const path = execSync(`which ${name}`, { encoding: 'utf8', timeout: 2000 }).trim();
      if (path) return path;
    } catch {}
  }

  return null;
}

// ── Cursor Anchor Math ──────────────────────────────────────────────────────
// Matches the Swift and Rust backends exactly.

const SAFE_LEFT = 20, SAFE_RIGHT = 27, SAFE_UP = 15, SAFE_DOWN = 39;

function computeTarget(cx, cy, winW, winH, anchor, offsetX, offsetY) {
  switch (anchor) {
    case 'top-left':     return { x: cx - SAFE_LEFT - winW + offsetX, y: cy - SAFE_UP - winH + offsetY };
    case 'top-right':    return { x: cx + SAFE_RIGHT + offsetX,       y: cy - SAFE_UP - winH + offsetY };
    case 'right':        return { x: cx + SAFE_RIGHT + offsetX,       y: cy - winH / 2 + offsetY };
    case 'bottom-right': return { x: cx + SAFE_RIGHT + offsetX,       y: cy + SAFE_DOWN + offsetY };
    case 'bottom-left':  return { x: cx - SAFE_LEFT - winW + offsetX, y: cy + SAFE_DOWN + offsetY };
    case 'left':         return { x: cx - SAFE_LEFT - winW + offsetX, y: cy - winH / 2 + offsetY };
    default:             return { x: cx + offsetX, y: cy + offsetY };
  }
}

function computeCursorTip(winW, winH, anchor, offsetX, offsetY) {
  if (anchor) {
    const base = computeTarget(0, 0, winW, winH, anchor, offsetX, offsetY);
    return { x: Math.round(-base.x), y: Math.round(winH - (-base.y)) };
  }
  return { x: Math.round(-offsetX), y: Math.round(winH + offsetY) };
}

// ── Spring Physics ──────────────────────────────────────────────────────────

const SPRING_STIFFNESS = 400, SPRING_DAMPING = 28, SPRING_DT = 1 / 120, SPRING_SETTLE = 0.5;

class SpringState {
  constructor(x, y) {
    this.posX = x; this.posY = y;
    this.velX = 0; this.velY = 0;
    this.targetX = x; this.targetY = y;
  }

  tick() {
    const dx = this.targetX - this.posX;
    const dy = this.targetY - this.posY;
    this.velX += (SPRING_STIFFNESS * dx - SPRING_DAMPING * this.velX) * SPRING_DT;
    this.velY += (SPRING_STIFFNESS * dy - SPRING_DAMPING * this.velY) * SPRING_DT;
    this.posX += this.velX * SPRING_DT;
    this.posY += this.velY * SPRING_DT;

    const dist = Math.sqrt(dx * dx + dy * dy);
    const vel = Math.sqrt(this.velX * this.velX + this.velY * this.velY);
    if (dist < SPRING_SETTLE && vel < SPRING_SETTLE) {
      this.posX = this.targetX;
      this.posY = this.targetY;
      this.velX = 0;
      this.velY = 0;
      return true;
    }
    return false;
  }
}

// ── X11 Helpers ─────────────────────────────────────────────────────────────

function xdotoolSearch(pid) {
  try {
    const out = execFileSync('xdotool', ['search', '--pid', String(pid), '--class', 'chromium'], {
      encoding: 'utf8', timeout: 5000,
    });
    return out.trim().split('\n').filter(Boolean);
  } catch { return []; }
}

function findChromeWindow(pid, expectedW, expectedH) {
  const wids = xdotoolSearch(pid);
  for (const wid of wids) {
    try {
      const geom = execFileSync('xdotool', ['getwindowgeometry', '--shell', wid], {
        encoding: 'utf8', timeout: 1000,
      });
      const w = parseInt((geom.match(/WIDTH=(\d+)/) || [])[1]);
      const h = parseInt((geom.match(/HEIGHT=(\d+)/) || [])[1]);
      if (Math.abs(w - expectedW) < 50 && Math.abs(h - expectedH) < 50) return wid;
    } catch {}
  }
  // Fallback: return the last wid (often the main window)
  return wids.length > 0 ? wids[wids.length - 1] : null;
}

function xSetAbove(wid) {
  try {
    execFileSync('xprop', [
      '-id', wid,
      '-f', '_NET_WM_STATE', '32a',
      '-set', '_NET_WM_STATE', '_NET_WM_STATE_ABOVE,_NET_WM_STATE_SKIP_TASKBAR,_NET_WM_STATE_SKIP_PAGER',
    ], { timeout: 2000 });
  } catch (e) { log(`xSetAbove failed: ${e.message}`); }
}

function xSetFrameless(wid) {
  try {
    execFileSync('xprop', [
      '-id', wid,
      '-f', '_MOTIF_WM_HINTS', '32c',
      '-set', '_MOTIF_WM_HINTS', '2, 0, 0, 0, 0',
    ], { timeout: 2000 });
  } catch (e) { log(`xSetFrameless failed: ${e.message}`); }
}

function xSetClickThrough(wid) {
  // Use python3 + ctypes to set empty X11 input shape via XFixes.
  // This avoids needing a compiled C helper.
  const script = `
import ctypes, ctypes.util, sys
wid = int(sys.argv[1])
x11 = ctypes.cdll.LoadLibrary(ctypes.util.find_library('X11'))
xfixes = ctypes.cdll.LoadLibrary(ctypes.util.find_library('Xfixes'))
dpy = x11.XOpenDisplay(None)
if not dpy: sys.exit(1)
xfixes.XFixesCreateRegion.restype = ctypes.c_ulong
region = xfixes.XFixesCreateRegion(dpy, None, 0)
xfixes.XFixesSetWindowShapeRegion(dpy, int(wid), 2, 0, 0, region)
xfixes.XFixesDestroyRegion(dpy, region)
x11.XFlush(dpy)
x11.XCloseDisplay(dpy)
`;
  try {
    execFileSync('python3', ['-c', script, wid], { timeout: 3000 });
  } catch (e) { log(`xSetClickThrough failed: ${e.message}`); }
}

function xWindowMove(wid, x, y) {
  try {
    execFileSync('xdotool', ['windowmove', '--sync', wid, String(Math.round(x)), String(Math.round(y))], {
      timeout: 1000,
    });
  } catch {}
}

function xWindowActivate(wid) {
  try {
    execFileSync('xdotool', ['windowactivate', '--sync', wid], { timeout: 2000 });
  } catch {}
}

function xWindowMinimize(wid) {
  try {
    execFileSync('xdotool', ['windowminimize', '--sync', wid], { timeout: 2000 });
  } catch {}
}

function xGetCursorPosition() {
  try {
    const out = execFileSync('xdotool', ['getmouselocation', '--shell'], {
      encoding: 'utf8', timeout: 500,
    });
    const x = parseInt((out.match(/X=(\d+)/) || [])[1]);
    const y = parseInt((out.match(/Y=(\d+)/) || [])[1]);
    if (!isNaN(x) && !isNaN(y)) return { x, y };
  } catch {}
  return null;
}

// ── Hyprland IPC ────────────────────────────────────────────────────────────

function hyprlandSocketPath() {
  const sig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!sig) return null;

  const candidates = [];
  if (process.env.XDG_RUNTIME_DIR) {
    candidates.push(join(process.env.XDG_RUNTIME_DIR, 'hypr', sig, '.socket.sock'));
  }
  const uid = process.env.UID || String(process.getuid?.() ?? '');
  if (uid) {
    candidates.push(join('/run/user', uid, 'hypr', sig, '.socket.sock'));
  }
  candidates.push(join('/tmp', 'hypr', sig, '.socket.sock'));

  return candidates.find(p => existsSync(p)) || null;
}

function hyprlandGetCursorPos(socketPath) {
  return new Promise((resolve) => {
    const sock = createConnection(socketPath, () => {
      sock.write('cursorpos');
    });
    let data = '';
    sock.on('data', (chunk) => { data += chunk.toString(); });
    sock.on('end', () => {
      const parts = data.trim().split(/[,\s]+/);
      if (parts.length >= 2) {
        const x = Math.round(parseFloat(parts[0]));
        const y = Math.round(parseFloat(parts[1]));
        if (!isNaN(x) && !isNaN(y)) { resolve({ x, y }); return; }
      }
      resolve(null);
    });
    sock.on('error', () => resolve(null));
    sock.setTimeout(200, () => { sock.destroy(); resolve(null); });
  });
}

// Synchronous version for startup (before event loop is running)
function hyprlandGetCursorPosSync(socketPath) {
  try {
    const out = execFileSync('socat', ['-', `UNIX-CONNECT:${socketPath}`], {
      input: 'cursorpos', encoding: 'utf8', timeout: 500,
    });
    const parts = out.trim().split(/[,\s]+/);
    if (parts.length >= 2) {
      const x = Math.round(parseFloat(parts[0]));
      const y = Math.round(parseFloat(parts[1]));
      if (!isNaN(x) && !isNaN(y)) return { x, y };
    }
  } catch {}
  // Fallback: try a quick Node net connect trick via execFileSync
  try {
    const script = `
      const s=require('net').createConnection('${socketPath}',()=>s.write('cursorpos'));
      s.on('data',d=>{process.stdout.write(d);s.destroy()});
      s.on('error',()=>process.exit(1));
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8', timeout: 500,
    });
    const parts = out.trim().split(/[,\s]+/);
    if (parts.length >= 2) {
      const x = Math.round(parseFloat(parts[0]));
      const y = Math.round(parseFloat(parts[1]));
      if (!isNaN(x) && !isNaN(y)) return { x, y };
    }
  } catch {}
  return null;
}

// ── CDP Transport ───────────────────────────────────────────────────────────

class CDPConnection {
  #proc;
  #nextId = 1;
  #pending = new Map();
  #eventHandlers = new Map();
  #buf = '';
  #ready;
  #readyResolve;

  constructor(chromePath, chromeArgs) {
    this.#ready = new Promise(r => { this.#readyResolve = r; });

    this.#proc = spawn(chromePath, chromeArgs, {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    });

    this.#proc.stderr.on('data', (d) => {
      const s = d.toString();
      // Only log interesting errors, suppress noisy ones
      if (s.includes('ERROR') && !s.includes('leveldb') && !s.includes('sandbox') &&
          !s.includes('gbm_support') && !s.includes('command_buffer') &&
          !s.includes('context_provider') && !s.includes('shared_memory') &&
          !s.includes('gcm') && !s.includes('GCM') && !s.includes('registration') &&
          !s.includes('wrong_secret') && !s.includes('DEPRECATED_ENDPOINT')) {
        log(`chrome: ${s.trim()}`);
      }
    });

    this.#proc.stdout.on('data', () => {}); // drain stdout

    // CDP responses come on FD 4 (chrome writes here)
    this.#proc.stdio[4].on('data', (chunk) => {
      this.#buf += chunk.toString();
      const parts = this.#buf.split('\0');
      this.#buf = parts.pop();
      for (const part of parts) {
        if (!part.trim()) continue;
        let msg;
        try { msg = JSON.parse(part); } catch { continue; }
        if (msg.id && this.#pending.has(msg.id)) {
          this.#pending.get(msg.id)(msg);
          this.#pending.delete(msg.id);
        } else if (msg.method) {
          const handlers = this.#eventHandlers.get(msg.method);
          if (handlers) {
            handlers.forEach(fn => fn(msg.params, msg.sessionId));
          }
        }
      }
    });

    this.#proc.on('exit', (code) => {
      // Resolve any pending promises so nothing hangs
      for (const [, resolve] of this.#pending) resolve({ error: { message: 'Process exited' } });
      this.#pending.clear();
    });

    // Signal ready immediately -- caller will poll for targets
    setTimeout(() => this.#readyResolve(), 0);
  }

  get proc() { return this.#proc; }
  get pid() { return this.#proc.pid; }

  send(method, params = {}, sessionId) {
    return new Promise((resolve) => {
      const id = this.#nextId++;
      this.#pending.set(id, resolve);
      const msg = sessionId
        ? { id, method, params, sessionId }
        : { id, method, params };
      try {
        this.#proc.stdio[3].write(JSON.stringify(msg) + '\0');
      } catch {
        this.#pending.delete(id);
        resolve({ error: { message: 'Write failed' } });
      }
    });
  }

  on(eventName, handler) {
    if (!this.#eventHandlers.has(eventName)) this.#eventHandlers.set(eventName, []);
    this.#eventHandlers.get(eventName).push(handler);
  }

  kill() {
    try { this.#proc.kill(); } catch {}
  }
}

// ── Status Item (Tray) Helper ───────────────────────────────────────────────

const TRAY_HELPER_SCRIPT = `
import gi, sys, json, os
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib, GdkPixbuf

import warnings
warnings.filterwarnings("ignore", category=DeprecationWarning)

class Tray:
    def __init__(self, title):
        self.icon = Gtk.StatusIcon()
        self.icon.set_from_icon_name("dialog-information")
        self.icon.set_title(title)
        self.icon.set_tooltip_text(title)
        self.icon.set_visible(True)
        self.icon.connect("activate", self.on_click)
        channel = GLib.IOChannel.unix_new(sys.stdin.fileno())
        GLib.io_add_watch(channel, GLib.IO_IN | GLib.IO_HUP, self.on_stdin)
        print(json.dumps({"type": "tray-ready"}), flush=True)

    def on_click(self, icon):
        print(json.dumps({"type": "click"}), flush=True)

    def on_stdin(self, channel, condition):
        if condition & GLib.IO_HUP:
            Gtk.main_quit()
            return False
        line = channel.readline()
        if not line:
            Gtk.main_quit()
            return False
        try:
            msg = json.loads(line)
            if msg.get("type") == "title":
                self.icon.set_title(msg.get("title", ""))
                self.icon.set_tooltip_text(msg.get("title", ""))
        except:
            pass
        return True

title = sys.argv[1] if len(sys.argv) > 1 else "Glimpse"
Tray(title)
Gtk.main()
`;

function spawnTrayHelper(title) {
  const proc = spawn('python3', ['-c', TRAY_HELPER_SCRIPT, title], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  proc.on('error', () => {});
  return proc;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();

  const chromePath = findChrome();
  if (!chromePath) {
    log('No Chromium or Chrome installation found.');
    log('Install chromium, chromium-browser, or google-chrome-stable, or set GLIMPSE_CHROME_PATH.');
    process.exit(1);
  }

  // Create temp profile
  const profileDir = mkdtempSync(join(tmpdir(), 'glimpse-chromium-'));
  const cleanup = () => { try { rmSync(profileDir, { recursive: true, force: true }); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { closeAndExit(); });
  process.on('SIGINT', () => { closeAndExit(); });

  // ── State ──────────────────────────────────────────────────────────
  let sessionId = null;
  let windowId = null;
  let xWindowId = null;
  let closed = false;
  let readyCount = 0; // Track ready events (first = blank page, second = user content)
  let followEnabled = config.followCursor;
  let cursorAnchor = config.cursorAnchor;
  let followMode = config.followMode;
  let cursorPollerInterval = null;
  let springTimer = null;
  let spring = null;
  let lastCursor = null;
  let trayProc = null;
  let trayVisible = false;
  let windowModesDone = false;

  const offsetX = config.cursorOffsetX;
  const offsetY = config.cursorOffsetY;

  // ── Cursor backend detection ───────────────────────────────────────
  // Prefer Hyprland IPC (async, no subprocess spawn per poll) over xdotool.
  const hyprSocket = hyprlandSocketPath();
  const cursorBackend = hyprSocket ? 'hyprland' : 'x11';
  if (hyprSocket) log(`cursor backend: Hyprland IPC (${hyprSocket})`);

  /** Get cursor position -- async for Hyprland, sync fallback for X11. */
  async function getCursorPositionAsync() {
    if (hyprSocket) {
      const pos = await hyprlandGetCursorPos(hyprSocket);
      if (pos) return pos;
    }
    return xGetCursorPosition();
  }

  /** Get cursor position synchronously (startup only). */
  function getCursorPositionSync() {
    if (hyprSocket) {
      const pos = hyprlandGetCursorPosSync(hyprSocket);
      if (pos) return pos;
    }
    return xGetCursorPosition();
  }

  // ── Build Chrome args ──────────────────────────────────────────────

  const chromeArgs = [
    '--app=data:text/html,<body></body>',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--disable-features=TranslateUI',
    '--metrics-recording-only',
    '--no-pings',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-pipe',
    `--window-size=${config.width},${config.height}`,
  ];

  if (config.transparent) chromeArgs.push('--enable-transparent-visuals');

  // Initial position
  if (config.followCursor) {
    const cursor = getCursorPositionSync();
    if (cursor) {
      const pos = computeTarget(cursor.x, cursor.y, config.width, config.height,
        cursorAnchor, offsetX, offsetY);
      chromeArgs.push(`--window-position=${Math.round(pos.x)},${Math.round(pos.y)}`);
      lastCursor = cursor;
    }
  } else if (config.hidden) {
    chromeArgs.push('--window-position=-10000,-10000');
  } else if (config.x != null && config.y != null) {
    chromeArgs.push(`--window-position=${config.x},${config.y}`);
  }

  // ── Launch Chrome ──────────────────────────────────────────────────

  const cdp = new CDPConnection(chromePath, chromeArgs);

  cdp.proc.on('exit', () => {
    if (!closed) {
      closed = true;
      emitEvent({ type: 'closed' });
      cleanup();
      process.exit(0);
    }
  });

  // ── CDP Setup ──────────────────────────────────────────────────────

  // Wait for the page target to appear
  let page = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise(r => setTimeout(r, 50));
    const resp = await cdp.send('Target.getTargets');
    if (resp.result?.targetInfos) {
      page = resp.result.targetInfos.find(t => t.type === 'page');
      if (page) break;
    }
  }

  if (!page) {
    log('Failed to find page target');
    cdp.kill();
    process.exit(1);
  }

  // Attach to the page
  const attachResp = await cdp.send('Target.attachToTarget', {
    targetId: page.targetId, flatten: true,
  });
  sessionId = attachResp.result?.sessionId;
  if (!sessionId) {
    log('Failed to attach to page target');
    cdp.kill();
    process.exit(1);
  }

  // ── CDP Event Handlers ─────────────────────────────────────────────
  // Register handlers BEFORE enabling domains so we don't miss initial events.

  cdp.on('Runtime.bindingCalled', (params) => {
    if (params.name !== '__glimpse_send') return;
    let data;
    try { data = JSON.parse(params.payload); } catch { return; }

    if (data.__glimpse_close) {
      closeAndExit();
      return;
    }

    emitEvent({ type: 'message', data });
    if (config.autoClose) closeAndExit();
  });

  cdp.on('Page.loadEventFired', async () => {
    readyCount++;
    const info = await collectSystemInfo();
    emitEvent({ type: 'ready', ...info });

    // Apply window modes once after first load (window exists now)
    if (!windowModesDone) {
      windowModesDone = true;
      await applyWindowModes();
    }
  });

  cdp.on('Fetch.requestPaused', (params) => {
    const url = params.request?.url || '';
    if ((url.startsWith('http://') || url.startsWith('https://')) && config.openLinks) {
      cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' }, sessionId);
      try {
        if (config.openLinksApp) {
          execFileSync(config.openLinksApp, [url], { timeout: 5000 });
        } else {
          execFileSync('xdg-open', [url], { timeout: 5000 });
        }
      } catch (e) { log(`open-links failed: ${e.message}`); }
    } else {
      cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId);
    }
  });

  // ── Enable Domains & Setup ─────────────────────────────────────────

  // Get window ID for bounds control
  const winResp = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId });
  windowId = winResp.result?.windowId;

  // Set up bridge: Runtime.addBinding creates a global function
  await cdp.send('Runtime.addBinding', { name: '__glimpse_send' }, sessionId);

  // Compute initial cursorTip value for the bridge
  let initialCursorTip = 'null';
  if (followEnabled) {
    const tip = computeCursorTip(config.width, config.height, cursorAnchor, offsetX, offsetY);
    initialCursorTip = `{x:${tip.x},y:${tip.y}}`;
  }

  // Inject bridge script (survives navigations)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.glimpse = {
        cursorTip: ${initialCursorTip},
        send(data) { __glimpse_send(JSON.stringify(data)); },
        close() { __glimpse_send(JSON.stringify({ __glimpse_close: true })); }
      };
    `,
  }, sessionId);

  // Transparent background
  if (config.transparent) {
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    }, sessionId);
  }

  // Open links interception
  if (config.openLinks) {
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: 'http://*', requestStage: 'Request' }, { urlPattern: 'https://*', requestStage: 'Request' }],
    }, sessionId);
  }

  // NOW enable Page and Runtime domains -- events will flow to our handlers above
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  // The initial blank page has already loaded, so Page.loadEventFired won't fire again.
  // Emit a synthetic ready for the initial blank page, just like native backends do.
  {
    const info = await collectSystemInfo();
    emitEvent({ type: 'ready', ...info });
    windowModesDone = true;
    await applyWindowModes();
  }

  // ── Status Item Mode ───────────────────────────────────────────────

  if (config.statusItem) {
    trayProc = spawnTrayHelper(config.title === 'Glimpse' ? 'G' : config.title);
    const trayRl = createInterface({ input: trayProc.stdout });
    trayRl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'click') {
          emitEvent({ type: 'click' });
          // Toggle window visibility
          trayVisible = !trayVisible;
          if (trayVisible) {
            showWindow();
          } else {
            hideWindow();
          }
        }
      } catch {}
    });
    trayProc.on('exit', () => { trayProc = null; });
    // Start hidden in status-item mode
    config.hidden = true;
  }

  // ── Window Mode Application ────────────────────────────────────────

  async function applyWindowModes() {
    // Wait a bit for the window to be mapped
    await new Promise(r => setTimeout(r, 200));

    xWindowId = findChromeWindow(cdp.pid, config.width, config.height);
    if (!xWindowId) {
      log('Could not find Chrome X11 window for mode application');
      return;
    }

    if (config.frameless) xSetFrameless(xWindowId);
    if (config.floating || config.followCursor) xSetAbove(xWindowId);
    if (config.clickThrough) xSetClickThrough(xWindowId);

    if (config.hidden) {
      xWindowMove(xWindowId, -10000, -10000);
    }

    // Start follow-cursor tracking
    if (config.followCursor) {
      startFollowCursor();
    }

    // Inject cursorTip if follow-cursor is active
    if (followEnabled) {
      const tip = computeCursorTip(config.width, config.height, cursorAnchor, offsetX, offsetY);
      cdp.send('Runtime.evaluate', {
        expression: `window.glimpse && (window.glimpse.cursorTip = {x:${tip.x},y:${tip.y}})`,
      }, sessionId);
    }
  }

  // ── System Info ────────────────────────────────────────────────────

  async function collectSystemInfo() {
    const infoJS = `JSON.stringify({
      sw: screen.width, sh: screen.height,
      avW: screen.availWidth, avH: screen.availHeight,
      avL: typeof screen.availLeft !== 'undefined' ? screen.availLeft : 0,
      avT: typeof screen.availTop !== 'undefined' ? screen.availTop : 0,
      dpr: devicePixelRatio,
      dark: matchMedia('(prefers-color-scheme:dark)').matches,
      reduceMotion: matchMedia('(prefers-reduced-motion:reduce)').matches,
      contrast: matchMedia('(prefers-contrast:more)').matches,
    })`;

    let screenData = {};
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: infoJS }, sessionId);
      if (r.result?.result?.value) screenData = JSON.parse(r.result.result.value);
    } catch {}

    const screen = {
      width: screenData.sw || 0,
      height: screenData.sh || 0,
      scaleFactor: Math.round(screenData.dpr || 1),
      visibleX: screenData.avL || 0,
      visibleY: screenData.avT || 0,
      visibleWidth: screenData.avW || 0,
      visibleHeight: screenData.avH || 0,
    };

    const cursor = lastCursor || getCursorPositionSync() || { x: 0, y: 0 };

    let cursorTip = null;
    if (followEnabled) {
      cursorTip = computeCursorTip(config.width, config.height, cursorAnchor, offsetX, offsetY);
    }

    return {
      screen,
      screens: [{ x: 0, y: 0, ...screen }],
      appearance: {
        darkMode: screenData.dark || false,
        accentColor: null,
        reduceMotion: screenData.reduceMotion || false,
        increaseContrast: screenData.contrast || false,
      },
      cursor,
      cursorTip,
    };
  }

  // ── Follow Cursor ──────────────────────────────────────────────────

  function startFollowCursor() {
    if (cursorPollerInterval) return;

    if (followMode === 'spring') {
      const cursor = getCursorPositionSync();
      if (cursor) {
        const pos = computeTarget(cursor.x, cursor.y, config.width, config.height,
          cursorAnchor, offsetX, offsetY);
        spring = new SpringState(pos.x, pos.y);
      } else {
        spring = new SpringState(0, 0);
      }
    }

    if (cursorBackend === 'hyprland') {
      // Async Hyprland IPC polling -- no subprocess spawn per tick
      let polling = false;
      cursorPollerInterval = setInterval(async () => {
        if (!followEnabled || !xWindowId || polling) return;
        polling = true;
        const cursor = await hyprlandGetCursorPos(hyprSocket);
        polling = false;
        if (!cursor) return;
        lastCursor = cursor;

        const target = computeTarget(cursor.x, cursor.y, config.width, config.height,
          cursorAnchor, offsetX, offsetY);

        if (followMode === 'spring' && spring) {
          spring.targetX = target.x;
          spring.targetY = target.y;
        } else {
          xWindowMove(xWindowId, target.x, target.y);
        }
      }, 8);
    } else {
      // X11: synchronous xdotool polling
      cursorPollerInterval = setInterval(() => {
        if (!followEnabled || !xWindowId) return;
        const cursor = xGetCursorPosition();
        if (!cursor) return;
        lastCursor = cursor;

        const target = computeTarget(cursor.x, cursor.y, config.width, config.height,
          cursorAnchor, offsetX, offsetY);

        if (followMode === 'spring' && spring) {
          spring.targetX = target.x;
          spring.targetY = target.y;
        } else {
          xWindowMove(xWindowId, target.x, target.y);
        }
      }, 8);
    }

    // Spring physics timer
    if (followMode === 'spring') {
      springTimer = setInterval(() => {
        if (!spring || !xWindowId) return;
        const settled = spring.tick();
        xWindowMove(xWindowId, spring.posX, spring.posY);
      }, 8);
    }
  }

  function stopFollowCursor() {
    if (cursorPollerInterval) { clearInterval(cursorPollerInterval); cursorPollerInterval = null; }
    if (springTimer) { clearInterval(springTimer); springTimer = null; }
    spring = null;
  }

  // ── Window Show/Hide ───────────────────────────────────────────────

  function showWindow(title) {
    if (title != null) {
      cdp.send('Runtime.evaluate', {
        expression: `document.title = ${JSON.stringify(title)}`,
      }, sessionId);
    }
    if (xWindowId) {
      if (config.hidden || config.statusItem) {
        // Move back from off-screen
        const cursor = getCursorPositionSync();
        let x = config.x != null ? config.x : 100;
        let y = config.y != null ? config.y : 100;
        if (cursor && config.statusItem) {
          // Position near cursor for tray popover behavior
          x = cursor.x - config.width / 2;
          y = cursor.y - config.height - 30;
        }
        xWindowMove(xWindowId, x, y);
      }
      xWindowActivate(xWindowId);
    }
    config.hidden = false;
  }

  function hideWindow() {
    if (xWindowId) xWindowMove(xWindowId, -10000, -10000);
  }

  // ── Close ──────────────────────────────────────────────────────────

  function closeAndExit() {
    if (closed) return;
    closed = true;
    stopFollowCursor();
    if (trayProc) { try { trayProc.kill(); } catch {} }
    cdp.kill();
    cleanup();
    // Write 'closed' and wait for stdout to drain before exiting.
    // This ensures the parent process reads the event before we die.
    const msg = JSON.stringify({ type: 'closed' }) + '\n';
    const flushed = process.stdout.write(msg);
    if (flushed) {
      setImmediate(() => process.exit(0));
    } else {
      process.stdout.once('drain', () => process.exit(0));
    }
  }

  // ── Stdin Command Handler ──────────────────────────────────────────

  const rl = createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    if (closed) return;
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try { msg = JSON.parse(trimmed); } catch {
      log(`bad message: ${trimmed}`);
      return;
    }

    switch (msg.type) {
      case 'html': {
        // msg.html is base64 encoded
        const dataUrl = `data:text/html;base64,${msg.html}`;
        await cdp.send('Page.navigate', { url: dataUrl }, sessionId);
        break;
      }

      case 'eval': {
        if (msg.js) {
          await cdp.send('Runtime.evaluate', { expression: msg.js }, sessionId);
        }
        break;
      }

      case 'file': {
        if (msg.path) {
          await cdp.send('Page.navigate', { url: `file://${msg.path}` }, sessionId);
        }
        break;
      }

      case 'show': {
        showWindow(msg.title);
        break;
      }

      case 'close': {
        closeAndExit();
        break;
      }

      case 'get-info': {
        const info = await collectSystemInfo();
        emitEvent({ type: 'info', ...info });
        break;
      }

      case 'title': {
        if (config.statusItem && trayProc) {
          trayProc.stdin.write(JSON.stringify({ type: 'title', title: msg.title }) + '\n');
        } else {
          await cdp.send('Runtime.evaluate', {
            expression: `document.title = ${JSON.stringify(msg.title || '')}`,
          }, sessionId);
        }
        break;
      }

      case 'resize': {
        const w = msg.width || config.width;
        const h = msg.height || config.height;
        if (windowId != null) {
          await cdp.send('Browser.setWindowBounds', {
            windowId, bounds: { width: w, height: h },
          });
        }
        config.width = w;
        config.height = h;
        break;
      }

      case 'follow-cursor': {
        const enabled = msg.enabled !== false;
        if (msg.anchor !== undefined) cursorAnchor = msg.anchor || null;
        if (msg.mode) {
          const wasSpring = followMode === 'spring';
          followMode = msg.mode;
          if (msg.mode === 'spring' && !wasSpring && xWindowId) {
            // Initialize spring from current position
            const cursor = getCursorPositionSync();
            if (cursor) {
              const pos = computeTarget(cursor.x, cursor.y, config.width, config.height,
                cursorAnchor, offsetX, offsetY);
              spring = new SpringState(pos.x, pos.y);
            }
          }
        }

        if (enabled && !followEnabled) {
          followEnabled = true;
          if (xWindowId) {
            xSetAbove(xWindowId);
            startFollowCursor();
          }
        } else if (!enabled && followEnabled) {
          followEnabled = false;
          stopFollowCursor();
        }

        // Update cursorTip
        if (followEnabled) {
          const tip = computeCursorTip(config.width, config.height, cursorAnchor, offsetX, offsetY);
          await cdp.send('Runtime.evaluate', {
            expression: `window.glimpse && (window.glimpse.cursorTip = {x:${tip.x},y:${tip.y}})`,
          }, sessionId);
        } else {
          await cdp.send('Runtime.evaluate', {
            expression: `window.glimpse && (window.glimpse.cursorTip = null)`,
          }, sessionId);
        }
        break;
      }

      default:
        log(`Unknown command: ${msg.type}`);
    }
  });

  rl.on('close', () => {
    // stdin EOF -- close
    closeAndExit();
  });
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});

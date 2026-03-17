import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINARY = process.env.GLIMPSE_BINARY_PATH ?? join(__dirname, 'glimpse');

class GlimpseWindow extends EventEmitter {
  #proc;
  #closed = false;
  #pendingHTML = null;
  #info = null;

  constructor(proc, initialHTML) {
    super();
    this.#proc = proc;
    this.#pendingHTML = initialHTML;

    proc.stdin.on('error', () => {}); // Swallow EPIPE if Swift exits first

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });

    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit('error', new Error(`Malformed protocol line: ${line}`));
        return;
      }

      switch (msg.type) {
        case 'ready': {
          const info = { screen: msg.screen, screens: msg.screens, appearance: msg.appearance, cursor: msg.cursor, cursorTip: msg.cursorTip ?? null };
          this.#info = info;
          if (this.#pendingHTML) {
            // First ready = blank page loaded. Send the queued HTML.
            this.setHTML(this.#pendingHTML);
            this.#pendingHTML = null;
          } else {
            // Subsequent ready = user HTML loaded. Notify caller.
            this.emit('ready', info);
          }
          break;
        }
        case 'info':
          this.#info = { screen: msg.screen, screens: msg.screens, appearance: msg.appearance, cursor: msg.cursor, cursorTip: msg.cursorTip ?? null };
          this.emit('info', this.#info);
          break;
        case 'message':
          this.emit('message', msg.data);
          break;
        case 'click':
          this.emit('click');
          break;
        case 'closed':
          if (!this.#closed) {
            this.#closed = true;
            this.emit('closed');
          }
          break;
        default:
          break;
      }
    });

    proc.on('error', (err) => this.emit('error', err));

    proc.on('exit', () => {
      if (!this.#closed) {
        this.#closed = true;
        this.emit('closed');
      }
    });
  }

  #write(obj) {
    if (this.#closed) return;
    this.#proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** @internal — for subclass use only */
  _write(obj) {
    this.#write(obj);
  }

  send(js) {
    this.#write({ type: 'eval', js });
  }

  setHTML(html) {
    this.#write({ type: 'html', html: Buffer.from(html).toString('base64') });
  }

  show(options = {}) {
    const msg = { type: 'show' };
    if (options.title != null) msg.title = options.title;
    this.#write(msg);
  }

  close() {
    this.#write({ type: 'close' });
  }

  loadFile(path) {
    this.#write({ type: 'file', path });
  }

  get info() {
    return this.#info;
  }

  getInfo() {
    this.#write({ type: 'get-info' });
  }

  followCursor(enabled, anchor, mode) {
    const msg = { type: 'follow-cursor', enabled };
    if (anchor !== undefined) msg.anchor = anchor;
    if (mode !== undefined) msg.mode = mode;
    this.#write(msg);
  }
}

function ensureBinary() {
  if (!existsSync(BINARY)) {
    throw new Error(
      "Glimpse binary not found. Run 'npm run build' or 'swiftc src/glimpse.swift -o src/glimpse'"
    );
  }
}

export function open(html, options = {}) {
  ensureBinary();

  const args = [];
  if (options.width != null)  args.push('--width',  String(options.width));
  if (options.height != null) args.push('--height', String(options.height));
  if (options.title != null)  args.push('--title',  options.title);

  if (options.frameless)    args.push('--frameless');
  if (options.floating)     args.push('--floating');
  if (options.transparent)  args.push('--transparent');
  if (options.clickThrough) args.push('--click-through');
  if (options.followCursor) args.push('--follow-cursor');
  if (options.hidden)      args.push('--hidden');
  if (options.autoClose)   args.push('--auto-close');
  if (options.openLinks)   args.push('--open-links');
  if (options.openLinksApp) args.push('--open-links-app', options.openLinksApp);

  if (options.x != null) args.push('--x', String(options.x));
  if (options.y != null) args.push('--y', String(options.y));

  if (options.cursorOffset?.x != null) args.push('--cursor-offset-x', String(options.cursorOffset.x));
  if (options.cursorOffset?.y != null) args.push('--cursor-offset-y', String(options.cursorOffset.y));
  if (options.cursorAnchor) args.push('--cursor-anchor', options.cursorAnchor);
  if (options.followMode != null) args.push('--follow-mode', options.followMode);

  const proc = spawn(BINARY, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  return new GlimpseWindow(proc, html);
}

class GlimpseStatusItem extends GlimpseWindow {
  setTitle(title) {
    this._write({ type: 'title', title });
  }

  resize(width, height) {
    this._write({ type: 'resize', width, height });
  }
}

export function statusItem(html, options = {}) {
  ensureBinary();

  const args = ['--status-item'];
  if (options.width != null)  args.push('--width',  String(options.width));
  if (options.height != null) args.push('--height', String(options.height));
  if (options.title != null)  args.push('--title',  options.title);

  const proc = spawn(BINARY, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  return new GlimpseStatusItem(proc, html);
}

export function prompt(html, options = {}) {
  return new Promise((resolve, reject) => {
    const win = open(html, { ...options, autoClose: true });
    let resolved = false;

    const timer = options.timeout
      ? setTimeout(() => {
          if (!resolved) { resolved = true; win.close(); reject(new Error('Prompt timed out')); }
        }, options.timeout)
      : null;

    win.once('message', (data) => {
      if (!resolved) {
        resolved = true;
        if (timer) clearTimeout(timer);
        resolve(data);
      }
    });

    win.once('closed', () => {
      if (timer) clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        resolve(null); // User closed window without sending a message
      }
    });

    win.once('error', (err) => {
      if (timer) clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 10_000;

const tmpDir = mkdtempSync(join(tmpdir(), 'glimpse-kiosk-'));
const argsPath = join(tmpDir, 'args.json');
const commandsPath = join(tmpDir, 'commands.jsonl');
const mockBinary = join(tmpDir, 'glimpse-mock');
const warnings = [];
const originalEmitWarning = process.emitWarning;

process.emitWarning = (warning, options) => {
  const detail = warning instanceof Error ? warning : new Error(String(warning));
  if (options && typeof options === 'object') {
    if (options.code != null) detail.code = options.code;
    if (options.type != null) detail.name = options.type;
  }
  warnings.push(detail);
};

console.log('glimpse kiosk protocol regression test');

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

function waitFor(emitter, event, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for '${event}' after ${timeoutMs}ms`));
    }, timeoutMs);

    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });

    emitter.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function writeMockBinary() {
  const protocolReady = JSON.stringify({
    type: 'ready',
    screen: { width: 800, height: 600, scaleFactor: 1, visibleX: 0, visibleY: 0, visibleWidth: 800, visibleHeight: 600 },
    screens: [],
    appearance: { darkMode: false, accentColor: '#000000', reduceMotion: false, increaseContrast: false },
    cursor: { x: 0, y: 0 },
  });
  const scriptLines = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const readline = require('node:readline');",
    "const argsPath = process.env.GLIMPSE_KIOSK_ARGS;",
    "const commandsPath = process.env.GLIMPSE_KIOSK_COMMANDS;",
    "const args = process.argv.slice(2);",
    "if (argsPath) fs.writeFileSync(argsPath, JSON.stringify(args));",
    `process.stdout.write(${JSON.stringify(protocolReady)} + '\\n');`,
    'let sentFinalReady = false;',
    'const emit = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");',
    'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
    'rl.on("line", (line) => {',
    '  if (commandsPath) fs.appendFileSync(commandsPath, line + "\\n");',
    '  let msg;',
    '  try { msg = JSON.parse(line); } catch { return; }',
    '  if (msg?.type === "html" && !sentFinalReady) {',
    `    process.stdout.write(${JSON.stringify(protocolReady)} + '\\n');`,
    '    sentFinalReady = true;',
    '    if (args.includes("--kiosk")) emit({ type: "kiosk", active: true, reason: "mock kiosk active" });',
    '  }',
    '  if (msg?.type === "kiosk") {',
    '    const active = msg.enabled !== false;',
    '    emit({ type: "kiosk", active, reason: active ? "mock kiosk active" : "kiosk mode disabled" });',
    '  }',
    '  if (msg?.type === "close") {',
    '    emit({ type: "closed" });',
    '    process.exit(0);',
    '  }',
    '});',
  ];

  writeFileSync(mockBinary, scriptLines.join('\n'));
  chmodSync(mockBinary, 0o755);
}

try {
  writeMockBinary();
  process.env.GLIMPSE_BINARY_PATH = mockBinary;
  process.env.GLIMPSE_KIOSK_ARGS = argsPath;
  process.env.GLIMPSE_KIOSK_COMMANDS = commandsPath;

  const { open } = await import('../src/glimpse.mjs');
  const win = open('<body>kiosk</body>', {
    kiosk: true,
    width: 320,
    height: 200,
    x: 10,
    y: 20,
    followCursor: true,
    followMode: 'spring',
    cursorAnchor: 'top-left',
    cursorOffset: { x: 1, y: 2 },
  });
  const ready = waitFor(win, 'ready');
  const initialKiosk = waitFor(win, 'kiosk');

  await ready;
  const [initial] = await initialKiosk;
  assert.deepEqual(initial, { active: true, reason: 'mock kiosk active' });
  pass('emits kiosk state from host protocol');

  const args = JSON.parse(readFileSync(argsPath, 'utf8'));
  assert.ok(args.includes('--kiosk'));
  assert.ok(!args.includes('--width'));
  assert.ok(!args.includes('--height'));
  assert.ok(!args.some((arg) => arg.startsWith('--x=')));
  assert.ok(!args.some((arg) => arg.startsWith('--y=')));
  assert.ok(!args.includes('--follow-cursor'));
  assert.ok(!args.includes('--follow-mode'));
  assert.ok(!args.includes('--cursor-anchor'));
  assert.ok(!args.some((arg) => arg.startsWith('--cursor-offset-')));
  assert.ok(warnings.some((warning) => warning.code === 'GLIMPSE_KIOSK_IGNORED_OPTIONS'));
  pass('maps open({ kiosk: true }) to --kiosk and ignores window geometry');

  const disabledEvent = waitFor(win, 'kiosk');
  win.kiosk(false);
  const [disabled] = await disabledEvent;
  assert.deepEqual(disabled, { active: false, reason: 'kiosk mode disabled' });

  const commands = readFileSync(commandsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(commands.some((msg) => msg.type === 'kiosk' && msg.enabled === false));
  pass('sends runtime kiosk disable command');

  win.close();
  await waitFor(win, 'closed');

  console.log('\nkiosk protocol test passed');
} finally {
  process.emitWarning = originalEmitWarning;
  rmSync(tmpDir, { recursive: true, force: true });
}

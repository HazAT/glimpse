import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { supportsFollowCursor } from '../src/follow-cursor-support.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TIMEOUT_MS = 10_000;

const tmpDir = mkdtempSync(join(tmpdir(), 'glimpse-companion-mode-'));
const mockBinary = join(tmpDir, 'glimpse-mock');

console.log('glimpse companion mode regression test');

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  throw new Error(msg);
}

function writeMockBinary() {
  const protocolReady = JSON.stringify({
    type: 'ready',
    screen: { width: 800, height: 600, scaleFactor: 1, visibleX: 0, visibleY: 0, visibleWidth: 800, visibleHeight: 600 },
    screens: [],
    appearance: { darkMode: false, accentColor: '#000000', reduceMotion: false, increaseContrast: false },
    cursor: { x: 0, y: 0 },
  });

  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const argsPath = process.env.GLIMPSE_COMPANION_ARGS_PATH;
if (argsPath) fs.writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)));
const protocolReady = ${protocolReady};
process.stdout.write(protocolReady + '\\n');
let sentFinalReady = false;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg && msg.type === 'html' && !sentFinalReady) {
      process.stdout.write(protocolReady + '\\n');
      sentFinalReady = true;
    }
    if (msg && msg.type === 'close') {
      process.stdout.write(JSON.stringify({ type: 'closed' }) + '\\n');
      process.exit(0);
    }
  } catch {
    // Ignore malformed JSON from this fixture.
  }
});
`;

  writeFileSync(mockBinary, script);
  chmodSync(mockBinary, 0o755);
}

function waitForFile(path, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (existsSync(path)) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timeout waiting for file: ${path}`));
      }
      setTimeout(poll, 50);
    })();
  });
}

async function collectArgsForMode(mode) {
  const argsPath = join(tmpDir, `args-${mode}.json`);
  const companionPath = join(__dirname, '..', 'pi-extension', 'companion.mjs');

  const env = {
    ...process.env,
    GLIMPSE_BINARY_PATH: mockBinary,
    GLIMPSE_COMPANION_ARGS_PATH: argsPath,
  };

  const childArgs = [companionPath];
  if (mode === 'follow') childArgs.push('--follow');

  const child = spawn(process.execPath, childArgs, {
    stdio: 'inherit',
    env,
  });

  try {
    await waitForFile(argsPath);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
  }

  return JSON.parse(readFileSync(argsPath, 'utf8'));
}

try {
  writeMockBinary();

  const staticArgs = await collectArgsForMode('static');
  if (staticArgs.includes('--follow-cursor')) {
    fail('static mode should not pass --follow-cursor');
  }
  if (!staticArgs.some((arg) => arg.startsWith('--x=')) || !staticArgs.some((arg) => arg.startsWith('--y='))) {
    fail('static mode should set a fixed x/y position');
  }
  pass('static mode uses fixed-position window without follow-cursor');

  const followArgs = await collectArgsForMode('follow');
  const followSupported = supportsFollowCursor();

  if (followSupported) {
    if (!followArgs.includes('--follow-cursor')) {
      fail('follow mode should pass --follow-cursor when supported');
    }
    pass('follow mode enables follow-cursor when supported');
  } else {
    if (followArgs.includes('--follow-cursor')) {
      fail('follow mode should not pass --follow-cursor when follow-cursor is unsupported');
    }
    pass('follow mode respects follow-cursor capability gating');
  }

  console.log('\ncompanion mode tests passed');
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

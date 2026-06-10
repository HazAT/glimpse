import { spawnSync } from 'node:child_process';
import { open } from '../src/glimpse.mjs';

const TIMEOUT_MS = 10_000;
const TITLE = `Glimpse Cmd-W Test ${process.pid}`;

const HTML = `<!doctype html>
<html>
  <body style="font-family: system-ui; padding: 24px;">
    <h1>Cmd-W close test</h1>
    <p>This window should close when the test sends ⌘W.</p>
  </body>
</html>`;

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

function sendCommandWToWindow(title) {
  const script = `
    tell application "System Events"
      repeat with appProcess in processes
        if name of appProcess is "glimpse" then
          repeat with appWindow in windows of appProcess
            if name of appWindow is "${title.replaceAll('"', '\\"')}" then
              set frontmost of appProcess to true
              perform action "AXRaise" of appWindow
              delay 0.2
              keystroke "w" using command down
              return
            end if
          end repeat
        end if
      end repeat
      error "No Glimpse window named ${title.replaceAll('"', '\\"')}"
    end tell
  `;

  return spawnSync('osascript', ['-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

if (process.platform !== 'darwin') {
  console.log('Cmd-W close test skipped: macOS-only keyboard shortcut');
  process.exit(0);
}

console.log('glimpse Cmd-W close test\n');

let win;
try {
  win = open(HTML, {
    title: TITLE,
    width: 520,
    height: 260,
  });

  await waitFor(win, 'ready');
  console.log('  ✓ window ready');

  const result = sendCommandWToWindow(TITLE);
  if (result.status !== 0) {
    throw new Error([
      'Failed to send ⌘W with osascript.',
      'This test requires macOS Accessibility permission for the terminal running npm.',
      result.stderr.trim(),
      result.stdout.trim(),
    ].filter(Boolean).join('\n'));
  }
  console.log('  ✓ sent ⌘W');

  await waitFor(win, 'closed');
  console.log('  ✓ closed event received');

  console.log('\nCmd-W close test passed');
  process.exit(0);
} catch (err) {
  console.error(`\n  ✗ ${err.message}`);
  win?.close();
  process.exit(1);
}

import { statusItem } from '../src/glimpse.mjs';

// statusItem is macOS-only
if (process.platform !== 'darwin') {
  console.log('glimpse status-item integration test\n  skipped (macOS-only feature)\n');
  process.exit(0);
}

const TIMEOUT_MS = 10_000;

const HTML = `<!DOCTYPE html>
<html>
  <body>
    <button id="btn" onclick="window.glimpse.send({action:'clicked'})">Click</button>
  </body>
</html>`;

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
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

console.log('glimpse status-item integration test\n');

let item;
try {
  // Step 1: Create status item
  item = statusItem(HTML, { title: 'TST', width: 300, height: 200 });
  pass('Status item created');

  // Step 2: Wait for ready
  await waitFor(item, 'ready');
  pass('ready event received');

  // Step 3: Eval — click button, verify message round-trip
  item.send(`document.getElementById('btn').click()`);
  const [data] = await waitFor(item, 'message');
  if (data?.action !== 'clicked') {
    fail(`Expected data.action === 'clicked', got: ${JSON.stringify(data)}`);
  }
  pass(`message received: ${JSON.stringify(data)}`);

  // Step 4: setTitle — verify no crash
  item.setTitle('AP-3');
  pass('setTitle sent (no crash)');

  // Step 5: resize — verify no crash
  item.resize(400, 300);
  pass('resize sent (no crash)');

  // Step 6: Close and verify closed event
  item.close();
  pass('Sent close');

  await waitFor(item, 'closed');
  pass('closed event received');

  console.log('\nAll status-item tests passed');
  process.exit(0);
} catch (err) {
  console.error(`\n  ✗ ${err.message}`);
  item?.close();
  process.exit(1);
}

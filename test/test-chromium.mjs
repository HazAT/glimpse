/**
 * Comprehensive test for the Chromium backend.
 * Tests every Glimpse feature: window modes, follow-cursor, eval, messages,
 * getInfo, setHTML, loadFile, show/hide, prompt, auto-close, status-item.
 *
 * Requires: DISPLAY set, system Chromium installed, xdotool available.
 * Run: DISPLAY=:35 GLIMPSE_BACKEND=chromium node test/test-chromium.mjs
 */

import { open, prompt, statusItem, supportsFollowCursor } from '../src/glimpse.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 15_000;
let passed = 0;
let failed = 0;

function pass(msg) {
  passed++;
  console.log(`  \u2713 ${msg}`);
}

function fail(msg) {
  failed++;
  console.error(`  \u2717 ${msg}`);
}

function waitFor(emitter, event, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: '${event}' after ${timeoutMs}ms`)), timeoutMs);
    emitter.once(event, (...args) => { clearTimeout(timer); resolve(args); });
    emitter.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

console.log('Glimpse Chromium backend - comprehensive test\n');

// ── Test 1: Basic open/ready/message/close ──────────────────────────────

async function testBasic() {
  console.log('1. Basic: open, ready, eval, message, close');
  const html = `<html><body>
    <button id="btn" onclick="window.glimpse.send({action:'clicked'})">Click</button>
  </body></html>`;

  const win = open(html, { width: 400, height: 300, title: 'Basic Test' });
  const [info] = await waitFor(win, 'ready');

  if (info?.screen?.width > 0) pass('ready event with screen info');
  else fail('ready missing screen info');

  if (info?.appearance && typeof info.appearance.darkMode === 'boolean') pass('appearance info present');
  else fail('appearance info missing');

  if (info?.cursor && typeof info.cursor.x === 'number') pass('cursor info present');
  else fail('cursor info missing');

  // Eval
  win.send(`document.getElementById('btn').click()`);
  const [data] = await waitFor(win, 'message');
  if (data?.action === 'clicked') pass('message received from eval click');
  else fail(`expected action=clicked, got ${JSON.stringify(data)}`);

  win.close();
  await waitFor(win, 'closed');
  pass('closed event received');
}

// ── Test 2: setHTML (second navigation) ─────────────────────────────────

async function testSetHTML() {
  console.log('\n2. setHTML: replace page content');
  const win = open('<html><body>page1</body></html>', { width: 300, height: 200 });
  await waitFor(win, 'ready');
  pass('first ready');

  // Replace with new HTML
  win.setHTML('<html><body><div id="x" onclick="glimpse.send({page:2})">page2</div></body></html>');
  await waitFor(win, 'ready');
  pass('second ready after setHTML');

  win.send(`document.getElementById('x').click()`);
  const [data] = await waitFor(win, 'message');
  if (data?.page === 2) pass('message from new page');
  else fail(`expected page=2, got ${JSON.stringify(data)}`);

  win.close();
  await waitFor(win, 'closed');
}

// ── Test 3: loadFile ────────────────────────────────────────────────────

async function testLoadFile() {
  console.log('\n3. loadFile: load HTML from disk');
  const tmpFile = join(tmpdir(), `glimpse-test-${Date.now()}.html`);
  writeFileSync(tmpFile, `<html><body><script>setTimeout(()=>glimpse.send({loaded:'file'}),500)</script></body></html>`);

  const win = open('<html><body>init</body></html>', { width: 300, height: 200 });
  await waitFor(win, 'ready');

  win.loadFile(tmpFile);
  await waitFor(win, 'ready'); // ready fires on new page load
  const [data] = await waitFor(win, 'message');
  if (data?.loaded === 'file') pass('loadFile works');
  else fail(`expected loaded=file, got ${JSON.stringify(data)}`);

  win.close();
  await waitFor(win, 'closed');
  try { unlinkSync(tmpFile); } catch {}
}

// ── Test 4: getInfo ─────────────────────────────────────────────────────

async function testGetInfo() {
  console.log('\n4. getInfo: request system info');
  const win = open('<html><body>info test</body></html>', { width: 300, height: 200 });
  await waitFor(win, 'ready');

  win.getInfo();
  const [info] = await waitFor(win, 'info');
  if (info?.screen?.width > 0) pass('info event with screen data');
  else fail('info missing screen data');

  if (info?.screens?.length > 0) pass('screens array present');
  else fail('screens array missing');

  win.close();
  await waitFor(win, 'closed');
}

// ── Test 5: hidden / show ───────────────────────────────────────────────

async function testHiddenShow() {
  console.log('\n5. Hidden/show: prewarm mode');

  // Collect messages as they arrive
  const messages = [];
  const win = open('<html><body><script>setTimeout(()=>glimpse.send({visible:true}),800)</script></body></html>', {
    width: 300, height: 200, hidden: true,
  });
  win.on('message', (data) => messages.push(data));

  await waitFor(win, 'ready');
  pass('ready while hidden');

  // Show the window
  win.show({ title: 'Now Visible' });
  pass('show() called');

  // Wait for the message if it hasn't arrived yet
  if (messages.length === 0) await waitFor(win, 'message');
  if (messages.some(m => m.visible === true)) pass('page script ran');
  else fail('page script did not send message');

  win.close();
  await waitFor(win, 'closed');
}

// ── Test 6: auto-close ─────────────────────────────────────────────────

async function testAutoClose() {
  console.log('\n6. Auto-close: close after first message');
  const win = open(
    '<html><body><script>setTimeout(()=>glimpse.send({auto:true}),500)</script></body></html>',
    { width: 300, height: 200, autoClose: true }
  );
  await waitFor(win, 'ready');
  pass('ready');

  const [data] = await waitFor(win, 'message');
  if (data?.auto === true) pass('message received');
  else fail('unexpected message');

  await waitFor(win, 'closed');
  pass('auto-closed after message');
}

// ── Test 7: prompt() helper ─────────────────────────────────────────────

async function testPrompt() {
  console.log('\n7. prompt(): one-shot helper');
  const result = await prompt(
    '<html><body><script>setTimeout(()=>glimpse.send({answer:42}),500)</script></body></html>',
    { width: 300, height: 200, timeout: 10000 }
  );
  if (result?.answer === 42) pass('prompt returned correct data');
  else fail(`expected answer=42, got ${JSON.stringify(result)}`);
}

// ── Test 8: window.glimpse.close() from page ────────────────────────────

async function testPageClose() {
  console.log('\n8. glimpse.close(): close from page JS');
  const win = open(
    '<html><body><script>setTimeout(()=>glimpse.close(),500)</script></body></html>',
    { width: 300, height: 200 }
  );
  await waitFor(win, 'ready');
  pass('ready');

  await waitFor(win, 'closed');
  pass('closed via glimpse.close()');
}

// ── Test 9: frameless window ────────────────────────────────────────────

async function testFrameless() {
  console.log('\n9. Frameless window');
  const win = open(
    '<html><body style="background:#222;color:lime;font:20px monospace;padding:20px">frameless<script>setTimeout(()=>glimpse.send({mode:"frameless"}),800)</script></body></html>',
    { width: 300, height: 150, frameless: true }
  );
  await waitFor(win, 'ready');
  pass('frameless window opened');

  const [data] = await waitFor(win, 'message');
  if (data?.mode === 'frameless') pass('page working in frameless mode');
  else fail('page did not work');

  win.close();
  await waitFor(win, 'closed');
}

// ── Test 10: floating window ────────────────────────────────────────────

async function testFloating() {
  console.log('\n10. Floating window (always on top)');
  const win = open(
    '<html><body style="background:#003;color:cyan;padding:20px">floating<script>setTimeout(()=>glimpse.send({mode:"floating"}),800)</script></body></html>',
    { width: 300, height: 150, floating: true }
  );
  await waitFor(win, 'ready');
  pass('floating window opened');

  const [data] = await waitFor(win, 'message');
  if (data?.mode === 'floating') pass('page working in floating mode');
  else fail('page did not work');

  win.close();
  await waitFor(win, 'closed');
}

// ── Test 11: follow cursor ──────────────────────────────────────────────

async function testFollowCursor() {
  console.log('\n11. Follow cursor');
  if (!supportsFollowCursor()) {
    console.log('  (skipped: follow-cursor not supported on this system)');
    return;
  }

  const win = open(
    '<html><body style="background:rgba(0,0,0,0.8);color:lime;font:14px monospace;padding:10px">following<script>setTimeout(()=>glimpse.send({following:true}),1500)</script></body></html>',
    { width: 200, height: 80, followCursor: true, frameless: true, floating: true }
  );
  await waitFor(win, 'ready');
  pass('follow-cursor window opened');

  const [data] = await waitFor(win, 'message');
  if (data?.following === true) pass('page working with follow-cursor');
  else fail('page did not work');

  // Test runtime toggle
  win.followCursor(false);
  await sleep(200);
  win.followCursor(true, 'top-right');
  await sleep(500);
  pass('follow-cursor runtime toggle');

  win.close();
  await waitFor(win, 'closed');
}

// ── Test 12: cursorTip ──────────────────────────────────────────────────

async function testCursorTip() {
  console.log('\n12. Cursor tip');
  if (!supportsFollowCursor()) {
    console.log('  (skipped: follow-cursor not supported)');
    return;
  }

  const win = open(
    `<html><body><script>
      setTimeout(() => {
        const tip = window.glimpse.cursorTip;
        glimpse.send({ hasTip: tip !== null, tip });
      }, 1500);
    </script></body></html>`,
    { width: 200, height: 100, followCursor: true, frameless: true, cursorAnchor: 'top-right' }
  );

  const [readyInfo] = await waitFor(win, 'ready');
  if (readyInfo?.cursorTip) pass('cursorTip in ready event');
  else fail('cursorTip missing from ready');

  const [data] = await waitFor(win, 'message');
  if (data?.hasTip) pass('cursorTip available in page JS');
  else fail('cursorTip not available in page');

  win.close();
  await waitFor(win, 'closed');
}

// ── Test 13: status item (tray) ─────────────────────────────────────────

async function testStatusItem() {
  console.log('\n13. Status item (system tray)');

  let item;
  try {
    item = statusItem(
      '<html><body style="background:#111;color:#0f0;padding:20px">Tray Content</body></html>',
      { title: 'GlimpseTest', width: 250, height: 150 }
    );
  } catch (e) {
    fail(`statusItem() threw: ${e.message}`);
    return;
  }

  await waitFor(item, 'ready');
  pass('status item ready');

  // Test setTitle
  item.setTitle('Updated');
  await sleep(300);
  pass('setTitle called');

  // Test resize
  item.resize(300, 200);
  await sleep(300);
  pass('resize called');

  item.close();
  await waitFor(item, 'closed');
  pass('status item closed');
}

// ── Test 14: transparent window ─────────────────────────────────────────

async function testTransparent() {
  console.log('\n14. Transparent window');
  const win = open(
    '<html><body style="background:transparent;color:white;font:20px monospace;padding:20px;text-shadow:0 0 10px cyan">transparent<script>setTimeout(()=>glimpse.send({mode:"transparent"}),800)</script></body></html>',
    { width: 300, height: 150, transparent: true, frameless: true }
  );
  await waitFor(win, 'ready');
  pass('transparent window opened');

  const [data] = await waitFor(win, 'message');
  if (data?.mode === 'transparent') pass('page working in transparent mode');
  else fail('page did not work');

  win.close();
  await waitFor(win, 'closed');
}

// ── Test 15: multiple messages ──────────────────────────────────────────

async function testMultipleMessages() {
  console.log('\n15. Multiple messages');
  const win = open(`<html><body><script>
    let i = 0;
    setInterval(() => { if (i < 3) glimpse.send({i: i++}); }, 200);
  </script></body></html>`, { width: 300, height: 200 });
  await waitFor(win, 'ready');

  const messages = [];
  for (let j = 0; j < 3; j++) {
    const [data] = await waitFor(win, 'message');
    messages.push(data);
  }

  if (messages.length === 3 && messages[2].i === 2) pass('received 3 sequential messages');
  else fail(`expected 3 messages, got ${messages.length}`);

  win.close();
  await waitFor(win, 'closed');
}

// ── Run all tests ───────────────────────────────────────────────────────

async function runAll() {
  try { await testBasic(); } catch (e) { fail(`Basic: ${e.message}`); }
  try { await testSetHTML(); } catch (e) { fail(`setHTML: ${e.message}`); }
  try { await testLoadFile(); } catch (e) { fail(`loadFile: ${e.message}`); }
  try { await testGetInfo(); } catch (e) { fail(`getInfo: ${e.message}`); }
  try { await testHiddenShow(); } catch (e) { fail(`hidden/show: ${e.message}`); }
  try { await testAutoClose(); } catch (e) { fail(`auto-close: ${e.message}`); }
  try { await testPrompt(); } catch (e) { fail(`prompt: ${e.message}`); }
  try { await testPageClose(); } catch (e) { fail(`pageClose: ${e.message}`); }
  try { await testFrameless(); } catch (e) { fail(`frameless: ${e.message}`); }
  try { await testFloating(); } catch (e) { fail(`floating: ${e.message}`); }
  try { await testFollowCursor(); } catch (e) { fail(`followCursor: ${e.message}`); }
  try { await testCursorTip(); } catch (e) { fail(`cursorTip: ${e.message}`); }
  try { await testStatusItem(); } catch (e) { fail(`statusItem: ${e.message}`); }
  try { await testTransparent(); } catch (e) { fail(`transparent: ${e.message}`); }
  try { await testMultipleMessages(); } catch (e) { fail(`multipleMessages: ${e.message}`); }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

runAll();

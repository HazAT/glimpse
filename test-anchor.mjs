import { open } from './src/glimpse.mjs';

const anchors = ['top-left', 'top-right', 'right', 'bottom-right', 'bottom-left', 'left'];
let current = 0;

const html = `<!DOCTYPE html>
<html>
<head>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: rgba(0,0,0,0.85);
  color: white;
  font-family: system-ui;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  overflow: hidden;
}
#label { font-weight: 600; font-size: 18px; }
#tip { position: absolute; width: 8px; height: 8px; background: #FF3B30; border-radius: 50%; pointer-events: none; }
#info { font-size: 11px; opacity: 0.6; margin-top: 6px; text-align: center; }
</style>
</head>
<body>
<div style="text-align:center">
  <div id="label"></div>
  <div id="info"></div>
</div>
<div id="tip"></div>
<script>
function update(anchor, tipX, tipY) {
  document.getElementById('label').textContent = anchor;
  document.getElementById('info').textContent = 'cursorTip: ' + tipX + ', ' + tipY;
  const dot = document.getElementById('tip');
  dot.style.left = (tipX - 4) + 'px';
  dot.style.top = (tipY - 4) + 'px';
}
</script>
</body>
</html>`;

const win = open(html, {
  width: 200,
  height: 80,
  frameless: true,
  floating: true,
  transparent: true,
  followCursor: true,
  cursorAnchor: anchors[0],
});

win.on('ready', (info) => {
  const tip = info.cursorTip || { x: 0, y: 0 };
  win.send(`update("${anchors[current]}", ${tip.x}, ${tip.y})`);
  console.log('Ready. Press Enter to cycle through anchor positions. Ctrl+C to quit.');
  console.log(`Current: ${anchors[current]}`);
});

// Cycle on Enter
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (key) => {
  if (key[0] === 3) { // Ctrl+C
    win.close();
    process.exit(0);
  }
  current = (current + 1) % anchors.length;
  const anchor = anchors[current];
  console.log(`Switching to: ${anchor}`);
  win.followCursor(true, anchor);
  // Get updated info for cursorTip
  setTimeout(() => {
    win.getInfo();
  }, 50);
});

win.on('info', (info) => {
  const tip = info.cursorTip || { x: 0, y: 0 };
  win.send(`update("${anchors[current]}", ${tip.x}, ${tip.y})`);
});

win.on('closed', () => process.exit(0));

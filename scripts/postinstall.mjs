import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildScript = join(__dirname, 'build.mjs');
const skippedBuildMarker = join(__dirname, '..', '.glimpse-build-skipped');

function hasCommand(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

rmSync(skippedBuildMarker, { force: true });

if (process.platform === 'darwin' && !hasCommand('swiftc')) {
  const message = 'Postinstall skipped native build because swiftc was not found. Install Xcode Command Line Tools, then run npm run build:macos.';
  writeFileSync(skippedBuildMarker, message + '\n');
  console.warn(`[glimpse] ${message}`);
  process.exit(0);
}

if (process.platform === 'linux') {
  if (!hasCommand('cargo')) {
    const message = 'Postinstall skipped native build because cargo was not found. Install Rust from https://rustup.rs, then run npm run build:linux.';
    writeFileSync(skippedBuildMarker, message + '\n');
    console.warn(`[glimpse] ${message}`);
    process.exit(0);
  }
  const pkgCheck = spawnSync('pkg-config', ['--exists', 'webkitgtk-6.0', 'gtk4', 'gtk4-layer-shell-0'], { stdio: 'pipe' });
  if (pkgCheck.status !== 0) {
    const message = 'Postinstall skipped native build because GTK4/WebKit2GTK dev packages are missing. See README for install instructions, then run npm run build:linux.';
    writeFileSync(skippedBuildMarker, message + '\n');
    console.warn(`[glimpse] ${message}`);
    process.exit(0);
  }
}

if (!['darwin', 'linux'].includes(process.platform)) {
  process.exit(0);
}

const result = spawnSync(process.execPath, [buildScript], { stdio: 'inherit' });
process.exit(result.status ?? 1);

import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || process.platform;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, extraOptions = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...extraOptions });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

switch (target) {
  case 'darwin':
    run('swiftc', ['-O', 'src/glimpse.swift', '-o', 'src/glimpse']);
    break;
  case 'linux': {
    const pkgCheck = spawnSync('pkg-config', ['--exists', 'webkitgtk-6.0', 'gtk4', 'gtk4-layer-shell-0'], { stdio: 'pipe' });
    if (pkgCheck.status !== 0) {
      fail([
        'Missing system dependencies. Install with:',
        '  Fedora:  dnf install gtk4-devel webkitgtk6.0-devel gtk4-layer-shell-devel',
        '  Ubuntu:  apt install libgtk-4-dev libwebkitgtk-6.0-dev libgtk4-layer-shell-dev',
        '  Arch:    pacman -S gtk4 webkitgtk-6.0 gtk4-layer-shell',
      ].join('\n'));
    }
    const cargoCheck = spawnSync('cargo', ['--version'], { stdio: 'pipe' });
    if (cargoCheck.error || cargoCheck.status !== 0) {
      fail('Rust toolchain not found. Install from https://rustup.rs');
    }
    const rustDir = join(__dirname, '..', 'src', 'linux');
    run('cargo', ['build', '--release'], { cwd: rustDir });
    const src = join(rustDir, 'target', 'release', 'glimpse');
    const dest = join(__dirname, '..', 'src', 'glimpse');
    copyFileSync(src, dest);
    console.log('Binary installed to src/glimpse');
    break;
  }
  default:
    fail(`Unsupported build target: ${target}`);
}

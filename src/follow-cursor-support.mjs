import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cached = null;

function nativeBinaryExists() {
  return existsSync(join(__dirname, 'glimpse'));
}

function env(name) {
  return (process.env[name] || '').toLowerCase();
}

function hyprlandSocketExists() {
  const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!signature) return false;

  const candidates = [];
  if (process.env.XDG_RUNTIME_DIR) {
    candidates.push(join(process.env.XDG_RUNTIME_DIR, 'hypr', signature, '.socket.sock'));
  }
  if (process.env.UID) {
    candidates.push(join('/run/user', process.env.UID, 'hypr', signature, '.socket.sock'));
  }
  candidates.push(join('/tmp', 'hypr', signature, '.socket.sock'));

  return candidates.some((path) => existsSync(path));
}

function detect() {
  if (process.platform === 'darwin') {
    return { supported: true, reason: null };
  }

  if (process.platform === 'win32') {
    return { supported: true, reason: null };
  }

  if (process.platform !== 'linux') {
    return { supported: false, reason: `unsupported platform: ${process.platform}` };
  }

  const sessionType = env('XDG_SESSION_TYPE');
  const desktop = [env('XDG_CURRENT_DESKTOP'), env('DESKTOP_SESSION')].filter(Boolean).join(' ');
  const isHyprland = Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE) || desktop.includes('hyprland');
  const isWayland = Boolean(process.env.WAYLAND_DISPLAY) || sessionType === 'wayland';
  const isX11 = Boolean(process.env.DISPLAY) || sessionType === 'x11';

  if (isHyprland) {
    return hyprlandSocketExists()
      ? { supported: true, reason: null }
      : { supported: false, reason: 'Hyprland detected but its IPC socket was not found' };
  }

  // Chromium backend supports X11 follow-cursor via xdotool
  const usingChromium = process.env.GLIMPSE_BACKEND === 'chromium' ||
    (process.platform === 'linux' && !nativeBinaryExists());

  if (isWayland && !usingChromium) {
    return { supported: false, reason: 'Wayland follow-cursor is disabled without a compositor-specific backend' };
  }

  if (isX11) {
    if (usingChromium) {
      return { supported: true, reason: null };
    }
    return { supported: false, reason: 'X11 follow-cursor backend is not implemented yet' };
  }

  return { supported: false, reason: 'No supported follow-cursor backend detected' };
}

export function getFollowCursorSupport() {
  if (!cached) cached = detect();
  return cached;
}

export function supportsFollowCursor() {
  return getFollowCursorSupport().supported;
}

import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function getCompanionSocketPath() {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\pi-companion';
  }
  return join(tmpdir(), 'pi-companion.sock');
}

export function usesNamedPipe(socketPath) {
  return socketPath.startsWith('\\\\.\\pipe\\');
}

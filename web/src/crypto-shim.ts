// Minimal browser shim for node's `crypto`, covering only what the engine uses:
// createHash('sha256').update(text).digest('hex'). Backed by js-sha256, so the
// digest matches node's crypto for UTF-8 input (same hashes as the CLI).
import { sha256 } from 'js-sha256';

export function createHash(_algorithm: string) {
  let buffer = '';
  return {
    update(data: string, _encoding?: string) {
      buffer += data;
      return this;
    },
    digest(_encoding?: string) {
      return sha256(buffer);
    }
  };
}

export default { createHash };

/** Terminal prompts for the setup wizard. Secrets are read without echo. */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import type { SetupIO } from './wizard.js';

export function terminalIO(): SetupIO & { close(): void } {
  let muted = false;
  // readline writes the typed characters through its output stream. Dropping them while a secret is typed keeps
  // tokens off the screen and out of the scrollback.
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding as BufferEncoding);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const question = (q: string) => new Promise<string>((res) => rl.question(q, res));
  return {
    say: (line = '') => process.stdout.write(`${line}\n`),
    async ask(q, fallback = '') {
      const a = (await question(`${q} `)).trim();
      return a || fallback;
    },
    async secret(q) {
      process.stdout.write(`${q} `);
      muted = true;
      try {
        return (await question('')).trim();
      } finally {
        muted = false;
        process.stdout.write('\n');
      }
    },
    close: () => rl.close(),
  };
}

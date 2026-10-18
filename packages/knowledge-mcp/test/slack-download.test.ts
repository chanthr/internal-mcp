/** Slack file download stops reading at maxBytes instead of loading the whole file into memory. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
const { downloadSlackFile } = await import('../src/plugins/slack/api.js');

let sent = 0;
let sawAuth = '';
const server = createServer((req, res) => {
  sawAuth = req.headers.authorization ?? '';
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  // 64 MB in 64 KB pieces, unless the client hangs up first.
  const piece = Buffer.alloc(64 * 1024, 'a');
  const write = () => {
    while (sent < 64 * 1024 * 1024) {
      sent += piece.length;
      if (!res.write(piece)) return void res.once('drain', write);
    }
    res.end();
  };
  write();
});
server.listen(0);
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.log`;
after(() => {
  server.closeAllConnections();
  server.close();
});

test('text download is cut at maxBytes and the rest is never read', async () => {
  const r = await downloadSlackFile(url, { asText: true, maxBytes: 1000 });
  assert.equal(r.truncated, true);
  assert.equal(r.text!.length, 1000);
  assert.equal(sawAuth, 'Bearer xoxb-test-token');
  assert.ok(sent < 16 * 1024 * 1024, `server wrote ${sent} bytes before the client stopped`);
});

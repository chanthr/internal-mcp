/**
 * A remote MCP server that connects but cannot list its tools: the gateway hangs up on it each time, instead of
 * leaving one open connection behind per try (and it is tried again on every call to one of its tools).
 * The remote is a minimal fake on this machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const { UpstreamManager } = await import('../src/core/upstream.js');

/** Streams the client opened to hear from the remote (GET), and how many of them are still open. */
const streams = { opened: 0, open: 0 };
const server = createServer((req, res) => {
  if (req.method === 'GET') {
    streams.opened++;
    streams.open++;
    req.on('close', () => streams.open--);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': open\n\n');
    return;
  }
  if (req.method !== 'POST') return void res.writeHead(200).end();
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const msg = JSON.parse(raw) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (msg.id === undefined) return void res.writeHead(202).end(); // a notification
    const reply =
      msg.method === 'initialize'
        ? { result: { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'broken', version: '1.0.0' } } }
        : { error: { code: -32603, message: 'listing failed' } };
    res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'session-1' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => {
  server.closeAllConnections();
  server.close();
});

const until = async (what: () => boolean, ms = 5_000) => {
  for (let t = 0; t < ms; t += 20) {
    if (what()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waited too long');
};

test('a remote that connects but cannot list its tools is hung up on, every time it is tried', async () => {
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const upstreams = new UpstreamManager([{ spec: { name: 'broken', url, prefix: 'broken_' }, group: 'g' }]);
  await upstreams.connectAll();
  const [status] = upstreams.statuses();
  assert.equal(status.connected, false);
  assert.match(status.error ?? '', /listing failed/);
  // Each call to one of its tools connects again, and fails the same way.
  for (let i = 0; i < 3; i++) await assert.rejects(upstreams.owner('broken_get_weather')!.call({}), /not connected \(.*listing failed/);
  assert.ok(streams.opened > 0, 'the remote was reached far enough to open its stream');
  await until(() => streams.open === 0);
});

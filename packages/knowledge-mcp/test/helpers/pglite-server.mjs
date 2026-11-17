// A Postgres engine (PGlite) served over TCP from a worker thread, for tests of the Postgres connection.
// In a thread of its own, so a query that sleeps does not hold the test's event loop (and its timers).
import { parentPort, workerData } from 'node:worker_threads';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const db = await PGlite.create();
await db.exec(workerData.seed);
const server = new PGLiteSocketServer({ db, port: workerData.port, host: '127.0.0.1' });
await server.start();
parentPort.on('message', async (m) => {
  if (m !== 'stop') return;
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
});
parentPort.postMessage('ready');

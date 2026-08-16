import fs from 'node:fs';
import Fastify from 'fastify';
import { DB_PATH, PORT, WORKSPACE_DIR } from './config.ts';
import { reconcileOrphanedRuns } from './db.ts';
import { registerRoutes } from './routes.ts';

fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

const app = Fastify({ logger: { level: process.env.VIBE_LOG_LEVEL ?? 'warn' } });

// The Vite dev server runs on a different port; allow it through in dev.
app.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', request.headers.origin ?? '*');
  reply.header('Access-Control-Allow-Headers', 'content-type');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (request.method === 'OPTIONS') reply.code(204).send();
});

await registerRoutes(app);

const orphaned = reconcileOrphanedRuns();
if (orphaned > 0) {
  console.log(`Reconciled ${orphaned} run(s) orphaned by a previous shutdown.`);
}

await app.listen({ port: PORT, host: '127.0.0.1' });

console.log(`vibe-tasking server  http://127.0.0.1:${PORT}`);
console.log(`  database   ${DB_PATH}`);
console.log(`  workspace  ${WORKSPACE_DIR}`);

#!/usr/bin/env node
import { loadConfig } from './config.js';
import { isEmpty, openDatabase } from './db.js';
import { log } from './log.js';
import { seedDatabase } from './seed.js';
import { runHttp } from './transports/http.js';
import { runStdio } from './transports/stdio.js';

const USAGE = 'Usage: mcp-store-server [stdio|http|seed]  (default: stdio)';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'stdio';
  if (!['stdio', 'http', 'seed'].includes(command)) {
    console.error(USAGE);
    process.exit(2);
  }

  const config = loadConfig();
  const db = openDatabase(config.databasePath);

  if (command === 'seed') {
    const summary = seedDatabase(db);
    log.info(
      `seeded ${config.databasePath}: ${summary.products} products, ` +
        `${summary.customers} customers, ${summary.orders} orders`,
    );
    db.close();
    return;
  }

  // First run: create the sample data so the server works out of the box.
  if (isEmpty(db)) {
    seedDatabase(db);
    log.info(`database was empty; seeded sample data into ${config.databasePath}`);
  }

  if (command === 'http') {
    const server = await runHttp(db, config);
    const shutdown = () => server.close(() => db.close());
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } else {
    await runStdio(db, config);
  }
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

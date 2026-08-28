import 'dotenv/config';
import { createApp } from './app';
import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const { app, sqliteStore } = createApp();

const server = app.listen(PORT, () => {
  logger.info(`Rate Limiter API running on http://localhost:${PORT}`);
  logger.info('Endpoints:');
  logger.info('  GET /foo          — Fixed Window  (memory)');
  logger.info('  GET /bar          — Sliding Window (memory)');
  logger.info('  GET /memory/foo   — Fixed Window  (in-memory)');
  logger.info('  GET /memory/bar   — Sliding Window (in-memory)');
  logger.info('  GET /sqlite/foo   — Fixed Window  (SQLite)');
  logger.info('  GET /sqlite/bar   — Sliding Window (SQLite)');
  logger.info('  GET /sqlite/baz   — Token Bucket  (SQLite)');
  logger.info('  GET /sqlite/qux   — Leaky Bucket  (SQLite)');
  logger.info('  GET /admin/health — Health check');
  logger.info('  GET /admin/clients — Registered clients');
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(async () => {
    await sqliteStore.close?.();
    logger.info('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

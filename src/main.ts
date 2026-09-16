import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './observability/logger.js';
import { createMetrics } from './observability/metrics.js';
import { buildApp } from './app.js';
import { buildCatalog, parseProductConfig } from './workbuddy/model-catalog.js';
import { WorkBuddyClient } from './workbuddy/client.js';
import { CredentialPool } from './workbuddy/credential-pool.js';
import { CredentialStore } from './workbuddy/credential-store.js';

async function loadModels(configPath: string) {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  const config = parseProductConfig(raw);
  return buildCatalog(config);
}

/**
 * Load the local .env file so config keys work without manual export. Uses
 * Node's native loader (no dependency). A missing .env is fine — the process
 * env / explicit variables still apply with precedence over .env values.
 */
function loadLocalEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // .env absent or unreadable — rely on the process environment instead.
  }
}

async function main() {
  loadLocalEnv();
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  const configPath = resolve('wb_v3config.public.json');
  const models = await loadModels(configPath);
  log.info('catalog loaded', { model_count: models.length });

  const credentialStore = await CredentialStore.fromKeyFile(
    resolve(config.accountStorePath),
    resolve(config.accountStoreKeyFile),
  );
  const pool = new CredentialPool({ strategy: 'round-robin', store: credentialStore });
  const snapshot = await credentialStore.load();
  if (snapshot) pool.restore(snapshot);
  log.info('account pool restored', { account_count: pool.size, strategy: pool.strategyName });
  const client = new WorkBuddyClient({
    upstreamUrl: config.upstreamUrl,
    credentials: pool,
    userAgent: config.upstreamUa,
    firstByteTimeoutMs: config.firstByteTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
  });

  const metrics = createMetrics();
  const version = (await readFile(resolve('package.json'), 'utf8').then((p) => JSON.parse(p).version ?? '0.0.0', () => '0.0.0')) as string;

  const app = buildApp({
    apiKey: config.apiKey,
    models,
    client,
    pool,
    credentialsPath: config.credentialsPath,
    modelAliases: config.modelAliases,
    toolTracePath: config.toolTracePath,
    metrics,
    upstreamUrl: config.upstreamUrl,
    upstreamUa: config.upstreamUa,
    startedAt: Date.now(),
    version,
  });

  app.addHook('onRequest', async (req, reply) => {
    const t0 = performance.now();
    reply.raw.on('finish', () => {
      log.info('request', {
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        duration_ms: Math.round(performance.now() - t0),
      });
    });
  });

  try {
    await app.listen({ port: config.port, host: config.host });
    log.info('listening', { host: config.host, port: config.port, admin: `http://${config.host}:${config.port}/admin` });
  } catch (err) {
    log.fatal('failed to listen', { host: config.host, port: config.port, error: String(err) });
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

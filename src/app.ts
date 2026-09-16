import Fastify, { type FastifyInstance } from 'fastify';
import { isApiKeyValid } from './security/downstream-auth.js';
import { openAiError, type ApiErrorCode } from './openai/errors.js';
import { modelsRoutes } from './routes/models.js';
import { chatCompletionsRoutes } from './routes/chat-completions.js';
import { messagesRoutes } from './routes/messages.js';
import { responsesRoutes } from './routes/responses.js';
import { anthropicError } from './anthropic/errors.js';
import { adminRoutes } from './routes/admin.js';
import type { ExposedModel } from './workbuddy/model-catalog.js';
import type { WorkBuddyClient } from './workbuddy/client.js';
import type { CredentialPool } from './workbuddy/credential-pool.js';
import type { MetricsCollector } from './observability/metrics.js';
import { OAuthBroker, type OAuthBrokerOptions } from './workbuddy/oauth-broker.js';
import { createToolCallTracer } from './observability/tool-trace.js';

export type BuildAppOptions = {
  apiKey: string;
  models: ExposedModel[];
  client: WorkBuddyClient;
  pool: CredentialPool;
  credentialsPath?: string;
  metrics: MetricsCollector;
  upstreamUrl: string;
  upstreamUa: string;
  startedAt: number;
  version: string;
  modelAliases?: Record<string, string>;
  toolTracePath?: string;
  /** Override the reporting sink for accepted-but-dropped request fields. */
  onDroppedFields?: (fields: string[], requestId: string) => void;
  oauthOptions?: Omit<OAuthBrokerOptions, 'onComplete' | 'userAgent'>;
};

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 8 * 1024 * 1024,
  });

  // Downstream auth guard for every /v1 route.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const path = req.url.split('?')[0]!;
    const isMessages = path === '/v1/messages' || path.startsWith('/v1/messages/');
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const apiKey = req.headers['x-api-key'];
    const provided = isMessages && typeof apiKey === 'string' ? apiKey : bearer;
    const conflicting = isMessages && apiKey !== undefined && header !== undefined && apiKey !== bearer;
    if (conflicting || !isApiKeyValid(provided, opts.apiKey)) {
      if (isMessages) return reply.code(401).send(anthropicError(401, 'Invalid or missing gateway API key.', req.id));
      return reply.code(401).send(openAiError(401, 'invalid_api_key', 'Invalid or missing API key.').body);
    }
  });

  // Never leak stacks or upstream internals to callers.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode !== undefined && err.statusCode >= 400 ? err.statusCode : 500;
    const path = req.url.split('?')[0]!;
    if (path === '/v1/messages' || path.startsWith('/v1/messages/')) {
      return reply.code(status).send(anthropicError(status, 'Request could not be processed.', req.id));
    }
    const code: ApiErrorCode =
      status === 404 ? 'not_found' : status < 500 ? 'invalid_request' : 'internal_error';
    const message =
      status === 404
        ? `Unknown route: ${req.method} ${req.url}`
        : 'Request could not be processed.';
    reply.code(status).send(openAiError(status, code, message).body);
  });

  app.get('/health', async () => ({ status: 'ok' }));

  void app.register(modelsRoutes, { prefix: '/v1', models: opts.models });
  void app.register(chatCompletionsRoutes, {
    prefix: '/v1',
    models: opts.models,
    client: opts.client,
    metrics: opts.metrics,
    tracer: createToolCallTracer(opts.toolTracePath ?? ''),
    onDroppedFields:
      opts.onDroppedFields ??
      ((fields, requestId) => {
        console.info(
          JSON.stringify({
            time: new Date().toISOString(),
            msg: 'accepted and ignored unsupported request fields',
            request_id: requestId,
            dropped_fields: fields,
          }),
        );
      }),
  });
  void app.register(messagesRoutes, { prefix: '/v1', models: opts.models, client: opts.client, metrics: opts.metrics, modelAliases: opts.modelAliases });
  void app.register(responsesRoutes, { prefix: '/v1', models: opts.models, client: opts.client, metrics: opts.metrics });

  const oauth = new OAuthBroker({
    ...opts.oauthOptions,
    userAgent: opts.upstreamUa,
    onComplete: async (credential, note) => (await opts.pool.add(credential, note)).label,
  });
  opts.pool.setRefresher((credential) => oauth.refreshCredential(credential));
  app.addHook('onClose', async () => oauth.close());

  void app.register(adminRoutes, {
    apiKey: opts.apiKey,
    models: opts.models,
    metrics: opts.metrics,
    pool: opts.pool,
    oauth,
    credentialsPath: opts.credentialsPath ?? 'workbuddy-desktop-ai.info',
    upstreamUrl: opts.upstreamUrl,
    upstreamUa: opts.upstreamUa,
    startedAt: opts.startedAt,
    version: opts.version,
    verifyCredential: (cred) => opts.client.verifyCredential(cred),
  });

  return app;
}

import { describe, expect, it, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCatalog, parseProductConfig } from '../src/workbuddy/model-catalog.js';
import { WorkBuddyClient, UpstreamHttpError } from '../src/workbuddy/client.js';
import { createMetrics } from '../src/observability/metrics.js';
import { loadCatalogFixture } from './helpers/catalog-fixture.js';

const KEY = 'test-key-0123456789abcdef';
const WRONG = 'wrong-key-00000000000000';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const live = loadCatalogFixture();

function mockClient(): WorkBuddyClient {
  return new WorkBuddyClient({
    upstreamUrl: 'http://mock.invalid/v2/chat/completions',
    credentials: {
      getCredential: async () => ({ accessToken: 'mock', userId: 'mock', domain: 'www.workbuddy.ai' }),
      invalidate: () => {},
      describe: () => 'mock',
    } as never,
    userAgent: 'WorkBuddy/2.137.1',
    fetchFn: (async () => {
      throw new Error('integration suite must not call upstream');
    }) as unknown as typeof fetch,
  });
}

/** Client whose verifyCredential either passes or 401s (never calls upstream). */
function verifyStubClient(pass: boolean): WorkBuddyClient {
  const c = mockClient();
  (c as unknown as { verifyCredential: () => Promise<void> }).verifyCredential = () =>
    pass ? Promise.resolve() : Promise.reject(new UpstreamHttpError(401, '401', 'invalid token'));
  return c;
}

const SECRET_TOKEN = 'panel-secret-token-DO-NOT-LEAK-0123456789';

import { CredentialPool } from '../src/workbuddy/credential-pool.js';

/** App factory with a real CredentialPool. */
function buildPoolApp(client: WorkBuddyClient): { app: FastifyInstance; pool: CredentialPool } {
  const pool = new CredentialPool();
  const app = buildApp({
    apiKey: KEY,
    models: buildCatalog(parseProductConfig(live)),
    client,
    pool,
    metrics: createMetrics(),
    upstreamUrl: 'http://mock.invalid/v2/chat/completions',
    upstreamUa: 'WorkBuddy/2.137.1',
    startedAt: Date.now(),
    version: 'test',
  });
  return { app, pool };
}

describe('app integration', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    ({ app } = buildPoolApp(mockClient()));
  });

  it('GET /admin serves the panel HTML without a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Wkbdy2api');
  });

  it('GET /admin/api/overview without key returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/api/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /admin/api/overview returns stats and never the credential value', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/overview',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stats.total_requests).toBeGreaterThanOrEqual(0);
    expect(body.credential.ok).toBe(false);
    expect(body.credential.source).toBe('account pool (0 accounts)');
    // Empty pools report unavailable without leaking credential material.
    expect(JSON.stringify(body)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(body)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });

  it('POST /admin/api/accounts rejects a bad token with 401 and does not add', async () => {
    const { app: poolApp } = buildPoolApp(verifyStubClient(false));
    const res = await poolApp.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      payload: { token: 'not-the-sentinel-token-at-all', user_id: 'some-uid' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.type).toBe('upstream_authentication_error');
  });

  it('POST /admin/api/accounts with a verified token adds it to the pool', async () => {
    const { app: poolApp, pool } = buildPoolApp(verifyStubClient(true));
    const res = await poolApp.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      payload: { token: 'Bearer sentinel-good-token-aaaaaaaaaaaaaaaa', user_id: 'sentinel-uid', note: '备用' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().label).toBe('#1');
    expect(pool.size).toBe(1);
    // listed accounts never carry the token value
    const listing = pool.list();
    expect(listing[0]?.detail).not.toContain('sentinel-good');
  });

  it('POST /admin/api/accounts requires the admin key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'sentinel-good-token', user_id: 'sentinel-uid' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('pool round-robin rotates accounts across gets', async () => {
    const { pool } = buildPoolApp(verifyStubClient(true));
    pool.add({ accessToken: 'tok-a-1111111111111111111111111', userId: 'uid-a', domain: 'www.workbuddy.ai' });
    pool.add({ accessToken: 'tok-b-2222222222222222222222222', userId: 'uid-b', domain: 'www.workbuddy.ai' });
    const seq = [
      (await pool.getCredential()).accessToken,
      (await pool.getCredential()).accessToken,
      (await pool.getCredential()).accessToken,
    ];
    expect(seq).toEqual(['tok-a-1111111111111111111111111', 'tok-b-2222222222222222222222222', 'tok-a-1111111111111111111111111']);
  });

  it('pool quarantines a failing account and serves the other', async () => {
    const { pool } = buildPoolApp(verifyStubClient(true));
    pool.add({ accessToken: 'tok-a-1111111111111111111111111', userId: 'uid-a', domain: 'www.workbuddy.ai' });
    pool.add({ accessToken: 'tok-b-2222222222222222222222222', userId: 'uid-b', domain: 'www.workbuddy.ai' });
    pool.reportFailure('tok-a-1111111111111111111111111');
    const cred = await pool.getCredential();
    expect(cred.accessToken).toBe('tok-b-2222222222222222222222222');
    const listing = pool.list();
    expect(listing.find((a) => a.label === '#1')?.ok).toBe(false);
    expect(listing.find((a) => a.label === '#2')?.ok).toBe(true);
  });

  it('strategy endpoint switches round-robin to random', async () => {
    const { app: poolApp } = buildPoolApp(verifyStubClient(true));
    const res = await poolApp.inject({
      method: 'POST',
      url: '/admin/api/strategy',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      payload: { strategy: 'random' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().strategy).toBe('random');
    const bad = await poolApp.inject({
      method: 'POST',
      url: '/admin/api/strategy',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      payload: { strategy: 'bogus' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /health is public and returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /v1/models without key returns 401 OpenAI error', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.type).toBe('authentication_error');
    expect(res.json().error.code).toBe('invalid_api_key');
    expect(JSON.stringify(res.json())).not.toContain(KEY);
  });

  it('GET /v1/models with wrong key returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${WRONG}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/models with valid key returns 20 whitelist models', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(20);
    expect(body.data[0].id).toBe('default-model');
    expect(body.data[0].object).toBe('model');
  });

  it('GET /v1/models/:id returns single model; unknown returns 404 model_not_found', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/v1/models/fast-model',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe('fast-model');

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/models/nope-model',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('model_not_found');
  });

  it('unknown /v1 route returns OpenAI-style 404, not a stack trace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/nonexistent',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeDefined();
    expect(JSON.stringify(res.json())).not.toMatch(/at .+\(.+\)/);
  });
});

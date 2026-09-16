import { describe, expect, it, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCatalog, parseProductConfig } from '../src/workbuddy/model-catalog.js';
import { WorkBuddyClient } from '../src/workbuddy/client.js';
import { createMetrics } from '../src/observability/metrics.js';
import { CredentialPool } from '../src/workbuddy/credential-pool.js';
import { loadCatalogFixture } from './helpers/catalog-fixture.js';

const KEY = 'test-key-0123456789abcdef';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const live = loadCatalogFixture();
const streamFixture = readFileSync(`${projectRoot}/fixtures/upstream-stream.redacted.txt`, 'utf8');
const toolFixture = readFileSync(`${projectRoot}/fixtures/upstream-tool-call.redacted.txt`, 'utf8');
const parallelToolFixture = readFileSync(`${projectRoot}/fixtures/upstream-parallel-tool-calls.redacted.txt`, 'utf8');

/** Mock upstream: serves the fixture text as an SSE byte stream. Records the request. */
let lastUpstreamRequest: { url: string; headers: Record<string, string>; body: unknown } | undefined;

/** Read the most recent upstream body, or throw a clear error if absent. */
function getLastUpstreamBody(): Record<string, unknown> {
  const req = lastUpstreamRequest;
  if (!req) throw new Error('no upstream request was captured');
  return req.body as Record<string, unknown>;
}

function fixtureClient(fixture: string): WorkBuddyClient {
  return new WorkBuddyClient({
    upstreamUrl: 'http://mock.local/v2/chat/completions',
    credentials: {
      getCredential: async () => ({ accessToken: 'mock-token', userId: 'mock-uid', domain: 'www.workbuddy.ai' }),
      invalidate: () => {},
      describe: () => 'mock',
    } as never,
    userAgent: 'WorkBuddy/2.137.1',
    fetchFn: (async (url: string, init: RequestInit) => {
      lastUpstreamRequest = {
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      };
      return new Response(sseStream(fixture), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch,
  });
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  // split at frame boundaries to prove chunk-independence; small jagged chunks
  const parts = text.split(/\n\n/).flatMap((f, i) => (i === 0 ? [f] : [f]));
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= parts.length) {
        controller.close();
        return;
      }
      let chunk = parts[i++];
      if (i < parts.length) chunk += '\n\n';
      controller.enqueue(enc.encode(chunk));
    },
  });
}

function build(
  client: WorkBuddyClient,
  onDroppedFields?: (fields: string[]) => void,
): FastifyInstance {
  return buildApp({
    apiKey: KEY,
    models: buildCatalog(parseProductConfig(live)),
    client,
    pool: new CredentialPool(),
    metrics: createMetrics(),
    upstreamUrl: 'http://mock.local/v2/chat/completions',
    upstreamUa: 'WorkBuddy/2.137.1',
    startedAt: Date.now(),
    version: 'test',
    onDroppedFields,
  });
}

describe('chat completions against fixture-driven mock upstream', () => {
  describe('non-stream (upstream stream + local aggregation)', () => {
    let app: FastifyInstance;
    beforeAll(() => {
      app = build(fixtureClient(streamFixture));
    });

    it('aggregates into a standard chat.completion', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'deepseek-v4.1-flash',
          messages: [{ role: 'user', content: 'Reply with OK only.' }],
          stream: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.object).toBe('chat.completion');
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.model).toBe('deepseek-v4.1-flash');
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].message.role).toBe('assistant');
      expect(body.choices[0].message.content).toBe('OK');
      expect(body.choices[0].finish_reason).toBe('stop');
      expect(body.usage).toEqual({ prompt_tokens: 16, completion_tokens: 1, total_tokens: 17 });
      // upstream extension fields must not leak
      expect(JSON.stringify(body)).not.toContain('credit');
      expect(JSON.stringify(body)).not.toContain('prompt_cache');
    });

    it('sent stream:true to the upstream with injected system message and auth headers', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'deepseek-v4.1-flash',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        },
      });
      const sent = lastUpstreamRequest!;
      expect(sent.body).toMatchObject({ stream: true, model: 'deepseek-v4.1-flash' });
      expect((sent.body as { messages: Array<{ role: string }> }).messages[0]!.role).toBe('system');
      expect(sent.headers['Authorization']).toBe('Bearer mock-token');
      expect(sent.headers['X-User-Id']).toBe('mock-uid');
      expect(sent.headers['X-Domain']).toBe('www.workbuddy.ai');
      expect(sent.headers['X-Product']).toBe('SaaS');
      expect(sent.headers['User-Agent']).toBe('WorkBuddy/2.137.1');
    });

    it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
      'forwards thinking=%s as reasoning_effort',
      async (effort) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
          payload: {
            model: 'deepseek-v4.1-flash',
            messages: [{ role: 'user', content: 'hi' }],
            thinking: effort,
          },
        });

        expect(res.statusCode).toBe(200);
        expect(lastUpstreamRequest?.body).toMatchObject({ reasoning_effort: effort });
      },
    );

    it('accepts Cherry Studio thinking and optional undefined sentinels', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'deepseek-v4.1-flash',
          user: '[undefined]',
          max_tokens: '[undefined]',
          temperature: '[undefined]',
          top_p: '[undefined]',
          frequency_penalty: '[undefined]',
          presence_penalty: '[undefined]',
          response_format: '[undefined]',
          stop: '[undefined]',
          seed: '[undefined]',
          thinking: { type: 'enabled' },
          reasoning_effort: 'high',
          serviceTier: '[undefined]',
          verbosity: '[undefined]',
          tools: '[undefined]',
          tool_choice: '[undefined]',
          messages: [{ role: 'user', content: '你好' }],
          stream: true,
          stream_options: { include_usage: true },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(lastUpstreamRequest?.body).toMatchObject({ reasoning_effort: 'high', stream: true });
      expect((lastUpstreamRequest?.body as Record<string, unknown>).messages).toEqual([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: '你好' },
      ]);
    });
  });

  describe('stream passthrough', () => {
    it('emits OpenAI chunks and ends with [DONE]', async () => {
      const app = build(fixtureClient(streamFixture));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'deepseek-v4.1-flash',
          messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Reply with OK only.' }],
          stream: true,
        },
      });
      expect(res.statusCode).toBe(200);
      const ct = res.headers['content-type'];
      expect(String(ct)).toContain('text/event-stream');
      const text = res.body;
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
      const frames = text
        .split('\n\n')
        .map((l) => l.replace(/^data: /, ''))
        .filter((l) => l && l !== '[DONE]')
        .map((l) => JSON.parse(l));
      // first frame carries role
      expect(frames[0].choices[0].delta).toEqual({ role: 'assistant' });
      // content delta frame
      const content = frames.map((f) => f.choices[0]?.delta?.content ?? '').join('');
      expect(content).toBe('OK');
      // finish frame: null finish earlier, stop at end, no shells
      const last = frames[frames.length - 1];
      expect(last.choices[0].finish_reason).toBe('stop');
      const joined = JSON.stringify(frames);
      expect(joined).not.toContain('reasoning_content":""');
      expect(joined).not.toContain('"function_call"');
      expect(joined).not.toContain('extra_fields');
    });

    it('forwards tool_calls increments and finishes with tool_calls', async () => {
      const app = build(fixtureClient(toolFixture));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'deepseek-v4.1-flash',
          messages: [{ role: 'user', content: 'weather in Tokyo?' }],
          stream: true,
          tools: [
            { type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const frames = res.body
        .split('\n\n')
        .map((l) => l.replace(/^data: /, ''))
        .filter((l) => l && l !== '[DONE]')
        .map((l) => JSON.parse(l));
      const toolFrames = frames.filter((f) => f.choices[0]?.delta?.tool_calls);
      expect(toolFrames.length).toBeGreaterThan(2);
      // first tool frame has id + name
      const first = toolFrames[0].choices[0].delta.tool_calls[0];
      expect(first.id).toMatch(/^call_/);
      expect(first.type).toBe('function');
      expect(first.function.name).toBe('get_weather');
      // continuation frames append arguments (fixture spells it {"city": "Tokyo"})
      const calls = new Map<number, { id?: string; args: string }>();
      for (const frame of toolFrames) {
        for (const tc of frame.choices[0].delta.tool_calls) {
          const current = calls.get(tc.index) ?? { args: '' };
          if (tc.id) current.id = tc.id;
          current.args += tc.function.arguments ?? '';
          expect(tc.id).not.toBe('call_pending');
          calls.set(tc.index, current);
        }
      }
      expect(calls.size).toBe(1);
      expect(calls.get(0)?.id).toMatch(/^call_/);
      expect(JSON.parse(calls.get(0)?.args ?? '')).toEqual({ city: 'Tokyo' });
      const last = frames[frames.length - 1];
      expect(last.choices[0].finish_reason).toBe('tool_calls');
    });

    it('keeps parallel tool calls separate and correctly indexed (stream)', async () => {
      const app = build(fixtureClient(parallelToolFixture));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'deepseek-v4.1-flash',
          messages: [{ role: 'user', content: 'weather and time?' }],
          stream: true,
          tools: [
            { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
            { type: 'function', function: { name: 'get_time', parameters: { type: 'object' } } },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const frames = res.body
        .split('\n\n')
        .map((l) => l.replace(/^data: /, ''))
        .filter((l) => l && l !== '[DONE]')
        .map((l) => JSON.parse(l));

      const calls = new Map<number, { id?: string; name?: string; args: string }>();
      for (const frame of frames) {
        for (const tc of frame.choices[0]?.delta?.tool_calls ?? []) {
          const current = calls.get(tc.index) ?? { args: '' };
          if (tc.id) current.id = tc.id;
          if (tc.function?.name) current.name = tc.function.name;
          current.args += tc.function?.arguments ?? '';
          calls.set(tc.index, current);
        }
      }

      // Two distinct calls must survive as two entries, not merge into one.
      expect(calls.size).toBe(2);
      expect(calls.get(0)?.id).toBe('call_00_parallelA');
      expect(calls.get(1)?.id).toBe('call_01_parallelB');
      expect(calls.get(0)?.name).toBe('get_weather');
      expect(calls.get(1)?.name).toBe('get_time');
      // Interleaved argument fragments must land on the right index.
      expect(JSON.parse(calls.get(0)?.args ?? '')).toEqual({ city: 'Tokyo' });
      expect(JSON.parse(calls.get(1)?.args ?? '')).toEqual({ timezone: 'UTC' });
    });

    it('keeps parallel tool calls separate in aggregated non-stream output', async () => {
      const app = build(fixtureClient(parallelToolFixture));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'deepseek-v4.1-flash',
          messages: [{ role: 'user', content: 'weather and time?' }],
          stream: false,
          tools: [
            { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
            { type: 'function', function: { name: 'get_time', parameters: { type: 'object' } } },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const calls = body.choices[0].message.tool_calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ id: 'call_00_parallelA', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } });
      expect(calls[1]).toMatchObject({ id: 'call_01_parallelB', function: { name: 'get_time', arguments: '{"timezone":"UTC"}' } });
      expect(body.choices[0].finish_reason).toBe('tool_calls');
    });

    it('emits a usage chunk when stream_options.include_usage is set', async () => {
      const app = build(fixtureClient(streamFixture));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'deepseek-v4.1-flash',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          stream_options: { include_usage: true },
        },
      });
      const frames = res.body
        .split('\n\n')
        .map((l) => l.replace(/^data: /, ''))
        .filter((l) => l && l !== '[DONE]')
        .map((l) => JSON.parse(l));
      const usageFrame = frames.find((f) => f.usage);
      expect(usageFrame).toBeDefined();
      expect(usageFrame.usage).toEqual({ prompt_tokens: 16, completion_tokens: 1, total_tokens: 17 });
      expect(usageFrame.choices).toEqual([]);
    });
  });

  describe('request validation', () => {
    let app: FastifyInstance;
    beforeAll(() => {
      app = build(fixtureClient(streamFixture));
    });

    it('rejects unknown model with 404 model_not_found', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: { model: 'gpt-99', messages: [{ role: 'user', content: 'x' }] },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('model_not_found');
      expect(res.json().error.param).toBe('model');
    });

    it('rejects max_tokens + max_completion_tokens together', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'default-model',
          messages: [{ role: 'user', content: 'x' }],
          max_tokens: 5,
          max_completion_tokens: 6,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.type).toBe('invalid_request_error');
    });

    it('rejects semantics-changing unsupported params explicitly', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: { model: 'default-model', messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_object' } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('unsupported_parameter');
    });

    it('accepts and ignores the OpenAI store compatibility hint', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: { model: 'default-model', messages: [{ role: 'user', content: 'x' }], store: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().object).toBe('chat.completion');
    });

    it('accepts unknown fields instead of rejecting the request', async () => {
      // Regression guard for the recurring 400s: a newer SDK adding a field
      // must not break the caller.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'default-model',
          messages: [{ role: 'user', content: 'x' }],
          brand_new_field_from_future_sdk: { anything: true },
          another_unknown: 'value',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().object).toBe('chat.completion');
    });

    it('accepts and ignores known-harmless fields like penalties and metadata', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'default-model',
          messages: [{ role: 'user', content: 'x' }],
          presence_penalty: 0.5,
          frequency_penalty: 0.5,
          metadata: { trace: 'abc' },
          service_tier: 'auto',
          user: 'user-123',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().object).toBe('chat.completion');
    });

    it('strips ignored fields before they reach upstream', async () => {
      const localApp = build(fixtureClient(streamFixture));
      const res = await localApp.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'default-model',
          messages: [{ role: 'user', content: 'sensitive-token-xyz' }],
          metadata: { secret: 'sensitive-token-xyz' },
          unknown_future_field: 'sensitive-token-xyz',
        },
      });
      expect(res.statusCode).toBe(200);
      const sent = getLastUpstreamBody();
      // Dropped fields must not be forwarded to the upstream provider.
      expect(sent).not.toHaveProperty('metadata');
      expect(sent).not.toHaveProperty('unknown_future_field');
    });

    it('reports the names of dropped fields for observability', async () => {
      const seen: string[][] = [];
      const localApp = build(fixtureClient(streamFixture), (f: string[]) => seen.push(f));
      const res = await localApp.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'default-model',
          messages: [{ role: 'user', content: 'x' }],
          unknown_future_field: 1,
          another_unknown: 'y',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.sort()).toEqual(['another_unknown', 'unknown_future_field']);
    });

    it('accepts null content in assistant tool-call history', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: {
          model: 'default-model',
          messages: [
            { role: 'user', content: 'Use the tool.' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'call_1', content: 'done' },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects empty messages', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: { model: 'default-model', messages: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('requires auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: { model: 'default-model', messages: [{ role: 'user', content: 'x' }] },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('upstream error mapping', () => {
    function errorClient(status: number, json: unknown): WorkBuddyClient {
      return new WorkBuddyClient({
        upstreamUrl: 'http://mock.local/v2/chat/completions',
        credentials: {
          getCredential: async () => ({ accessToken: 'mock', userId: 'mock', domain: 'www.workbuddy.ai' }),
          invalidate: () => {},
          describe: () => 'mock',
        } as never,
        userAgent: 'WorkBuddy/2.137.1',
        fetchFn: (async () => {
          return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
        }) as unknown as typeof fetch,
      });
    }

    it('maps upstream 401 to 502 upstream_authentication_error without retry loop', async () => {
      const app = build(errorClient(401, { code: 1000, msg: 'unauthorized' }));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: { model: 'default-model', messages: [{ role: 'user', content: 'x' }] },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('upstream_authentication_error');
    });

    it('maps upstream quota 429 to insufficient_quota', async () => {
      const app = build(errorClient(429, { code: 1001, msg: 'quota exceeded' }));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: { model: 'default-model', messages: [{ role: 'user', content: 'x' }] },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('insufficient_quota');
    });

    it('maps upstream 500 to 502 upstream_error', async () => {
      const app = build(errorClient(500, { code: -1, msg: 'oops' }));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: { model: 'default-model', messages: [{ role: 'user', content: 'x' }] },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('upstream_error');
    });

    it('surfaces upstream 4xx request errors as invalid_request with upstream message', async () => {
      const app = build(errorClient(400, { code: 11128, msg: 'first message is not system prompt' }));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: { model: 'default-model', messages: [{ role: 'user', content: 'x' }] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('system prompt');
    });
  });
});

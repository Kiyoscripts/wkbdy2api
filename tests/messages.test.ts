import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { CredentialPool } from '../src/workbuddy/credential-pool.js';
import { WorkBuddyClient } from '../src/workbuddy/client.js';
import { createMetrics } from '../src/observability/metrics.js';
import { messagesSchema, normalizeAnthropicRequestBody, toWorkBuddyMessageRequest } from '../src/anthropic/request-mapper.js';
import type { UpstreamChatRequest } from '../src/workbuddy/request-mapper.js';
import type { ExposedModel } from '../src/workbuddy/model-catalog.js';
import { loadConfig } from '../src/config.js';

const KEY = 'messages-local-test-key';
const UPSTREAM_KEY = 'mock-upstream-private-key';
const MODEL = 'deepseek-v4.1-flash';
const textFixture = readFileSync(new URL('../fixtures/upstream-stream.redacted.txt', import.meta.url), 'utf8');
const toolFixture = readFileSync(new URL('../fixtures/upstream-tool-call.redacted.txt', import.meta.url), 'utf8');
const models: ExposedModel[] = [{ id: MODEL, object: 'model', created: 0, owned_by: 'workbuddy', x_workbuddy: { is_default: true, max_output_tokens: 1000, supports_tool_call: true, supports_images: true } }];
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function setup(response: string | (() => Response | Promise<Response>) = textFixture, aliases?: Record<string, string>) {
  const upstream: Array<{ headers: Headers; body: UpstreamChatRequest; signal?: AbortSignal | null }> = [];
  const pool = new CredentialPool();
  pool.restore({
    version: 1,
    strategy: 'round-robin',
    nextLabel: 2,
    accounts: [{
      label: '#1',
      credential: { accessToken: UPSTREAM_KEY, userId: 'mock-subject', domain: 'www.workbuddy.ai' },
    }],
  });
  const metrics = createMetrics();
  const client = new WorkBuddyClient({
    upstreamUrl: 'https://mock.invalid/v2/chat/completions', userAgent: 'test/1', credentials: pool,
    fetchFn: (async (_url, init) => {
      upstream.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers), signal: init?.signal });
      return typeof response === 'function' ? response() : new Response(response, { headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch,
  });
  const app = buildApp({ apiKey: KEY, models, client, pool, metrics, upstreamUrl: 'https://mock.invalid/v2/chat/completions', upstreamUa: 'test/1', startedAt: Date.now(), version: 'test', modelAliases: aliases });
  apps.push(app);
  const request = (payload: unknown = { model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }] }, headers: Record<string, string> = { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }) =>
    app.inject({ method: 'POST', url: '/v1/messages', payload: JSON.stringify(payload), headers: { 'content-type': 'application/json', ...headers } });
  const sdk = async () => {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    return new Anthropic({ baseURL: url, apiKey: KEY, authToken: null, maxRetries: 0 });
  };
  return { app, upstream, metrics, request, sdk };
}

const payload = { model: MODEL, max_tokens: 100, messages: [{ role: 'user' as const, content: 'Hi' }] };
const tool = { name: 'get_weather', description: 'Weather', input_schema: { type: 'object' as const, properties: { city: { type: 'string' } } } };

describe('Messages protocol routes', () => {
  it('accepts x-api-key and aggregates text into an Anthropic Message', async () => {
    const { request, upstream, metrics } = setup();
    const result = await request({ ...payload, system: [{ type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } }] });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 16, output_tokens: 1 } });
    expect(result.json().id).toMatch(/^msg_/);
    expect(upstream[0]?.body).toMatchObject({ stream: true, max_tokens: 100, messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Hi' }] });
    expect(upstream[0]?.headers.get('authorization')).toBe('Bearer ' + UPSTREAM_KEY);
    expect(upstream[0]?.headers.get('x-api-key')).toBeNull();
    expect(result.body).not.toContain(UPSTREAM_KEY);
    expect(metrics.snapshot()).toMatchObject({ total_requests: 1, tokens: { prompt: 16, completion: 1 } });
    expect(metrics.snapshot().recent[0]?.path).toBe('/v1/messages');
  });

  it('supports Bearer auth but rejects ambiguous credentials', async () => {
    const { app, request } = setup();
    const bearer = await app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: 'Bearer ' + KEY }, payload });
    expect(bearer.statusCode).toBe(200);
    for (const headers of [{}, { 'x-api-key': 'incorrect' }, { 'x-api-key': KEY, authorization: 'Bearer different' }]) {
      const result = await request(payload, headers as never);
      expect(result.statusCode).toBe(401);
      expect(result.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    }
  });

  it('accepts x-api-key on OpenAI routes and rejects conflicting headers', async () => {
    const { app } = setup();
    const xKey = await app.inject({ url: '/v1/models', headers: { 'x-api-key': KEY } });
    expect(xKey.statusCode).toBe(200);
    const conflict = await app.inject({
      url: '/v1/models',
      headers: { 'x-api-key': KEY, authorization: 'Bearer different' },
    });
    expect(conflict.statusCode).toBe(401);
    expect(conflict.json().error.code).toBe('invalid_api_key');
  });

  it('requires explicit model aliases and reports the actual upstream model', async () => {
    const { request, upstream } = setup(textFixture, { 'claude-local': MODEL });
    expect((await request({ ...payload, model: 'claude-unknown' })).statusCode).toBe(404);
    const aliased = await request({ ...payload, model: 'claude-local' });
    expect(aliased.statusCode).toBe(200);
    expect(aliased.headers['x-wkbdy-upstream-model']).toBe(MODEL);
    expect(aliased.json().model).toBe(MODEL);
    expect(upstream[0]?.body.model).toBe(MODEL);
    expect((await request({ ...payload, model: 'toString' })).statusCode).toBe(404);
  });

  it.each([
    { max_tokens: 0 }, { max_tokens: 1001 }, { messages: [] },
    { thinking: { type: 'enabled', budget_tokens: 0 } }, { stop_sequences: ['END'] },
    { messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] },
    { tools: [{ type: 'web_search_20260209', name: 'web_search' }] },
  ])('rejects invalid or unsupported semantics without calling upstream: %j', async (change) => {
    const { request, upstream } = setup();
    const result = await request({ ...payload, ...change });
    expect(result.statusCode).toBe(400);
    expect(result.json().type).toBe('error');
    expect(upstream).toHaveLength(0);
  });

  it('uses Anthropic errors for invalid JSON, version and token counting', async () => {
    const { app, request, upstream } = setup();
    const bad = await app.inject({ method: 'POST', url: '/v1/messages', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, payload: '{' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().type).toBe('error');
    expect((await request(payload, { 'x-api-key': KEY, 'anthropic-version': 'wrong' })).statusCode).toBe(400);
    const count = await app.inject({ method: 'POST', url: '/v1/messages/count_tokens', headers: { 'x-api-key': KEY }, payload });
    expect(count.statusCode).toBe(501);
    expect(count.json()).toMatchObject({ type: 'error', error: { type: 'api_error' } });
    expect(upstream).toHaveLength(0);
  });

  it('emits named SSE events, never the OpenAI DONE sentinel', async () => {
    const { request } = setup();
    const result = await request({ ...payload, stream: true });
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toContain('text/event-stream');
    const events = result.body.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.split('\ndata: ')[1]!));
    expect(events.map((e) => e.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(events[2].delta).toEqual({ type: 'text_delta', text: 'OK' });
    expect(events.at(-2).usage).toMatchObject({ input_tokens: 16, output_tokens: 1 });
    expect(result.body).not.toContain('[DONE]');
  });

  it.each([401, 403, 429, 500])('maps early upstream %d before sending SSE headers', async (status) => {
    const { request } = setup(() => new Response(JSON.stringify({ code: status, msg: UPSTREAM_KEY }), { status, headers: { 'Retry-After': '30' } }));
    const result = await request({ ...payload, stream: true });
    expect(result.statusCode).toBe(status === 429 ? 429 : 502);
    expect(result.headers['content-type']).toContain('application/json');
    if (status === 429) expect(result.headers['retry-after']).toBe('30');
    expect(result.json().type).toBe('error');
    expect(result.body).not.toContain(UPSTREAM_KEY);
    expect(result.body).not.toContain('event:');
  });

  it('never emits message_stop after truncated upstream EOF', async () => {
    const { request, metrics } = setup(textFixture.replace('data: [DONE]', ''));
    const result = await request({ ...payload, stream: true });
    expect(result.body).toContain('event: error');
    expect(result.body).not.toContain('event: message_stop');
    expect(metrics.snapshot().total_errors).toBe(1);
    const nonstream = await request(payload);
    expect(nonstream.statusCode).toBe(502);
  });

  it('rejects invalid tool JSON instead of fabricating an input object', async () => {
    const broken = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_one', function: { name: 'f', arguments: '{oops' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n';
    const { request } = setup(broken);
    expect((await request()).statusCode).toBe(502);
  });
});

describe('Anthropic SDK compatibility over real local HTTP', () => {
  it('cancels an idle upstream reader when the SDK aborts', async () => {
    const cancel = vi.fn();
    const { sdk, upstream } = setup(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' }, finish_reason: '' }] }) + '\n\n'));
      }, cancel,
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const client = await sdk();
    const stream = await client.messages.create({ ...payload, stream: true });
    for await (const event of stream) {
      if (event.type === 'content_block_delta') { stream.controller.abort(); break; }
    }
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(upstream[0]?.signal?.aborted).toBe(true);
  });

  it('handles two interleaved tool calls with separate block indexes', async () => {
    const rows = [
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'first_call', function: { name: 'get_weather', arguments: '{"city":' } },
        { index: 1, id: 'second_call', function: { name: 'get_weather', arguments: '{"city":' } },
      ] }, finish_reason: '' }] },
      { choices: [{ delta: { tool_calls: [
        { index: 1, function: { arguments: '"Paris"}' } }, { index: 0, function: { arguments: '"Tokyo"}' } },
      ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 20 } },
    ];
    const { sdk } = setup(rows.map((r) => 'data: ' + JSON.stringify(r) + '\n\n').join('') + 'data: [DONE]\n\n');
    const result = await (await sdk()).messages.stream({ ...payload, tools: [tool] }).finalMessage();
    expect(result.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, input: b.input }))).toEqual([
      { id: 'first_call', input: { city: 'Tokyo' } }, { id: 'second_call', input: { city: 'Paris' } },
    ]);
  });

  it('messages.create and messages.stream().finalMessage work for text', async () => {
    const { sdk } = setup();
    const client = await sdk();
    const result = await client.messages.create(payload);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'OK' });
    const stream = client.messages.stream(payload);
    const final = await stream.finalMessage();
    expect(final.stop_reason).toBe('end_turn');
    expect(final.content[0]).toMatchObject({ type: 'text', text: 'OK' });
    expect(final.usage.input_tokens).toBe(16);
  });

  it('SDK assembles streamed tool input and preserves IDs through a tool-result roundtrip', async () => {
    const { sdk, upstream } = setup(toolFixture);
    const client = await sdk();
    const result = await client.messages.stream({ ...payload, tools: [tool] }).finalMessage();
    const call = result.content.find((b) => b.type === 'tool_use')!;
    expect(result.stop_reason).toBe('tool_use');
    expect(call.input).toEqual({ city: 'Tokyo' });
    const nonstream = await client.messages.create({ ...payload, tools: [tool] });
    expect(nonstream.content.find((b) => b.type === 'tool_use')?.input).toEqual({ city: 'Tokyo' });
    await client.messages.create({ ...payload, tools: [tool], messages: [
      ...payload.messages, { role: 'assistant', content: result.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'Sunny' }] },
    ] });
    const roundtrip = upstream.at(-1)!.body.messages as Array<Record<string, unknown>>;
    expect(roundtrip.at(-1)).toMatchObject({ role: 'tool', tool_call_id: call.id, content: 'Sunny' });
    expect(JSON.stringify(roundtrip)).not.toContain('call_pending');
  });
});

describe('Messages request mapping', () => {
  it('maps base64 and URL images without fetching them in the gateway', () => {
    const request = messagesSchema.parse({ ...payload, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }, { type: 'text', text: 'What is this?' },
    ] }] });
    expect(toWorkBuddyMessageRequest(request, MODEL).messages[1]?.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
      { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }, { type: 'text', text: 'What is this?' },
    ]);
  });

  it.each([
    [{ role: 'assistant', content: 'prefill' }],
    [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }] }],
    [{ role: 'user', content: [{ type: 'tool_use', id: 'x', name: 'f', input: {} }] }],
  ])('rejects invalid conversation structure', (messages) => {
    expect(() => toWorkBuddyMessageRequest(messagesSchema.parse({ ...payload, messages }), MODEL)).toThrow();
  });

  it('maps tool choice and sampling parameters', () => {
    const request = messagesSchema.parse({ ...payload, tools: [tool], tool_choice: { type: 'tool', name: 'get_weather', disable_parallel_tool_use: true }, temperature: 0.3, top_p: 0.9 });
    expect(toWorkBuddyMessageRequest(request, MODEL)).toMatchObject({ tool_choice: { type: 'function', function: { name: 'get_weather' } }, parallel_tool_calls: false, temperature: 0.3, top_p: 0.9 });
  });

  it.each([
    [{ type: 'disabled' }, 'none'],
    [{ type: 'adaptive' }, 'high'],
    [{ type: 'enabled', budget_tokens: 1024 }, 'low'],
    [{ type: 'enabled', budget_tokens: 2048 }, 'medium'],
    [{ type: 'enabled', budget_tokens: 8192 }, 'high'],
    [{ type: 'enabled', budget_tokens: 32768 }, 'xhigh'],
  ])('maps Anthropic thinking %j to reasoning_effort %s', (thinking, reasoningEffort) => {
    const request = messagesSchema.parse({ ...payload, thinking });
    expect(toWorkBuddyMessageRequest(request, MODEL)).toMatchObject({ reasoning_effort: reasoningEffort });
  });

  it('maps output_config effort and lets thinking take precedence', () => {
    const outputOnly = messagesSchema.parse({ ...payload, output_config: { effort: 'high' } });
    expect(toWorkBuddyMessageRequest(outputOnly, MODEL).reasoning_effort).toBe('high');
    const thinkingFirst = messagesSchema.parse({ ...payload, thinking: { type: 'enabled', budget_tokens: 2048 }, output_config: { effort: 'max' } });
    expect(toWorkBuddyMessageRequest(thinkingFirst, MODEL).reasoning_effort).toBe('medium');
  });

  it('normalizes Cherry optional sentinels without changing message text', () => {
    const body = normalizeAnthropicRequestBody({
      ...payload,
      temperature: '[undefined]',
      messages: [{ role: 'user', content: [{ type: 'text', text: '[undefined]', cache_control: '[undefined]' }] }],
    }) as Record<string, unknown>;
    expect(body.temperature).toBeUndefined();
    const message = (body.messages as Array<Record<string, unknown>>)[0]!;
    const block = (message.content as Array<Record<string, unknown>>)[0]!;
    expect(block.text).toBe('[undefined]');
    expect(block.cache_control).toBeUndefined();
  });

  it('accepts the Cherry Studio enabled thinking payload and preserves precedence', () => {
    const raw = {
      model: MODEL,
      max_tokens: 17408,
      temperature: '[undefined]',
      top_k: '[undefined]',
      top_p: '[undefined]',
      stop_sequences: '[undefined]',
      thinking: { type: 'enabled', budget_tokens: 13312 },
      output_config: { effort: 'high' },
      system: '[undefined]',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好', cache_control: '[undefined]' }] }],
      tools: '[undefined]',
      tool_choice: '[undefined]',
      stream: true,
    };
    const request = messagesSchema.parse(normalizeAnthropicRequestBody(raw));
    expect(toWorkBuddyMessageRequest(request, MODEL).reasoning_effort).toBe('high');
    expect(toWorkBuddyMessageRequest(request, MODEL).messages.at(-1)?.content).toEqual('你好');
  });

  it('validates explicit aliases configuration', () => {
    expect(loadConfig({ WKB2API_API_KEY: KEY, WKB2API_ACCOUNT_STORE_KEY_FILE: 'test-account-store.key', WKB2API_MODEL_ALIASES: '{"claude-local":"default-model"}' }).modelAliases).toEqual({ 'claude-local': 'default-model' });
    expect(() => loadConfig({ WKB2API_API_KEY: KEY, WKB2API_ACCOUNT_STORE_KEY_FILE: 'test-account-store.key', WKB2API_MODEL_ALIASES: 'not-json' })).toThrow('WKB2API_MODEL_ALIASES');
  });
});

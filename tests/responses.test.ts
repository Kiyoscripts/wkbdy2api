import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createMetrics } from '../src/observability/metrics.js';
import { CredentialPool } from '../src/workbuddy/credential-pool.js';
import { WorkBuddyClient } from '../src/workbuddy/client.js';
import { buildCatalog, parseProductConfig } from '../src/workbuddy/model-catalog.js';
import { loadCatalogFixture } from './helpers/catalog-fixture.js';

const KEY = 'test-key-0123456789abcdef';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const live = loadCatalogFixture();
const streamFixture = readFileSync(`${projectRoot}/fixtures/upstream-stream.redacted.txt`, 'utf8');
const toolFixture = readFileSync(`${projectRoot}/fixtures/upstream-tool-call.redacted.txt`, 'utf8');

let lastUpstreamRequest: { url: string; headers: Record<string, string>; body: unknown; signal?: AbortSignal } | undefined;

function sseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = text.match(/[\s\S]{1,37}/g) ?? [];
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  });
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
        signal: init.signal ?? undefined,
      };
      return new Response(sseStream(fixture), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch,
  });
}

function responseClient(status: number, body: unknown): WorkBuddyClient {
  return new WorkBuddyClient({
    upstreamUrl: 'http://mock.local/v2/chat/completions',
    credentials: {
      getCredential: async () => ({ accessToken: 'mock-token', userId: 'mock-uid', domain: 'www.workbuddy.ai' }),
      invalidate: () => {},
      describe: () => 'mock',
    } as never,
    userAgent: 'WorkBuddy/2.137.1',
    fetchFn: (async () => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch,
  });
}

function build(client: WorkBuddyClient): FastifyInstance {
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
  });
}

const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

describe('Responses API', () => {
  describe('request mapping and non-stream response', () => {
    let app: FastifyInstance;

    beforeAll(() => {
      app = build(fixtureClient(streamFixture));
    });

    it('maps Responses fields to the WorkBuddy chat request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: {
          model: 'deepseek-v4.1-flash',
          instructions: 'Be concise.',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with OK only.' }] }],
          temperature: 0.25,
          top_p: 0.8,
          max_output_tokens: 64,
          parallel_tool_calls: false,
          reasoning: { effort: 'high' },
          tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object' }, strict: true }],
          tool_choice: { type: 'function', name: 'lookup' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(lastUpstreamRequest?.body).toMatchObject({
        model: 'deepseek-v4.1-flash',
        stream: true,
        temperature: 0.25,
        top_p: 0.8,
        max_tokens: 64,
        parallel_tool_calls: false,
        reasoning_effort: 'high',
        tool_choice: 'lookup',
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: [{ type: 'text', text: 'Reply with OK only.' }] },
        ],
        tools: [{ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' }, strict: true } }],
      });
    });

    it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
      'accepts top-level thinking=%s and forwards it as reasoning_effort',
      async (effort) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/responses',
          headers,
          payload: {
            model: 'deepseek-v4.1-flash',
            input: 'Reply with OK only.',
            thinking: effort,
          },
        });

        expect(res.statusCode).toBe(200);
        expect(lastUpstreamRequest?.body).toMatchObject({ reasoning_effort: effort });
      },
    );

    it('gives top-level thinking precedence over standard reasoning.effort', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: {
          model: 'deepseek-v4.1-flash',
          input: 'Reply with OK only.',
          thinking: 'max',
          reasoning: { effort: 'low' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(lastUpstreamRequest?.body).toMatchObject({ reasoning_effort: 'max' });
    });

    it('aggregates the upstream SSE stream into an OpenAI response', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: { model: 'deepseek-v4.1-flash', input: 'Reply with OK only.' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.object).toBe('response');
      expect(body.id).toMatch(/^resp_/);
      expect(body.status).toBe('completed');
      expect(body.output[0]).toMatchObject({
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'OK', annotations: [], logprobs: [] }],
      });
      expect(body.usage).toEqual({
        input_tokens: 16,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 17,
      });
    });
  });

  it('emits typed Responses SSE lifecycle events', async () => {
    const app = build(fixtureClient(streamFixture));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: { model: 'deepseek-v4.1-flash', input: 'Reply with OK only.', stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/event-stream');
    const events = res.body
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => {
        const lines = frame.split('\n');
        return { event: lines[0]?.replace('event: ', ''), data: JSON.parse(lines[1]!.replace('data: ', '')) };
      });
    expect(events.map((entry) => entry.event)).toEqual(expect.arrayContaining([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]));
    expect(events.filter((entry) => entry.event === 'response.output_text.delta').map((entry) => entry.data.delta).join('')).toBe('OK');
    expect(events.at(-1)?.data.response.status).toBe('completed');
  });

  it('maps function-call input/output and returns an aggregated function call', async () => {
    const app = build(fixtureClient(toolFixture));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: {
        model: 'deepseek-v4.1-flash',
        input: [
          { type: 'function_call', call_id: 'call_previous', name: 'get_weather', arguments: '{"city":"Tokyo"}' },
          { type: 'function_call_output', call_id: 'call_previous', output: 'sunny' },
          { type: 'message', role: 'user', content: 'What next?' },
        ],
        tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
      },
    });

    expect(res.statusCode).toBe(200);
    const sent = lastUpstreamRequest?.body as { messages: unknown[] };
    expect(sent.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'call_previous' })] }),
      { role: 'tool', content: 'sunny', tool_call_id: 'call_previous' },
    ]));
    const call = res.json().output.find((item: { type: string }) => item.type === 'function_call');
    expect(call).toMatchObject({ type: 'function_call', status: 'completed', name: 'get_weather' });
    expect(() => JSON.parse(call.arguments)).not.toThrow();
  });

  it('rejects max_output_tokens above the model limit before calling upstream', async () => {
    lastUpstreamRequest = undefined;
    const app = build(fixtureClient(streamFixture));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: { model: 'deepseek-v4.1-flash', input: 'x', max_output_tokens: 1_000_000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'invalid_request', param: 'max_output_tokens' });
    expect(lastUpstreamRequest).toBeUndefined();
  });

  it('rejects a function output that references an unknown call', async () => {
    const app = build(fixtureClient(streamFixture));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: {
        model: 'deepseek-v4.1-flash',
        input: [{ type: 'function_call_output', call_id: 'missing', output: 'x' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('unknown call_id');
  });

  it('maps upstream authentication, quota, and server failures', async () => {
    const cases = [
      { status: 401, body: { code: 1000, msg: 'unauthorized' }, expectedStatus: 502, code: 'upstream_authentication_error' },
      { status: 429, body: { code: 1001, msg: 'quota exceeded' }, expectedStatus: 429, code: 'insufficient_quota' },
      { status: 500, body: { code: -1, msg: 'oops' }, expectedStatus: 502, code: 'upstream_error' },
    ];
    for (const value of cases) {
      const app = build(responseClient(value.status, value.body));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: { model: 'deepseek-v4.1-flash', input: 'x' },
      });
      expect(res.statusCode).toBe(value.expectedStatus);
      expect(res.json().error.code).toBe(value.code);
    }
  });

  it('reports a malformed or incomplete upstream stream without returning a completed response', async () => {
    const malformed = 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":""}]}\n\n';
    const app = build(fixtureClient(malformed));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: { model: 'deepseek-v4.1-flash', input: 'x' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('upstream_protocol_error');
  });

  it('propagates cancellation to the upstream request signal', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const client = new WorkBuddyClient({
      upstreamUrl: 'http://mock.local/v2/chat/completions',
      credentials: {
        getCredential: async () => ({ accessToken: 'mock-token', userId: 'mock-uid', domain: 'www.workbuddy.ai' }),
        invalidate: () => {},
        describe: () => 'mock',
      } as never,
      userAgent: 'WorkBuddy/2.137.1',
      fetchFn: (async (_url: string, init: RequestInit) => {
        upstreamSignal = init.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const pending = client.streamChatCompletion({ model: 'deepseek-v4.1-flash', messages: [], stream: true }, controller.signal);
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow();
    expect(upstreamSignal?.aborted).toBe(true);
  });
});

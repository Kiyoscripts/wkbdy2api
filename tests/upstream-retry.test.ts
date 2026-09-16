import { describe, expect, it, vi } from 'vitest';
import { WorkBuddyClient } from '../src/workbuddy/client.js';
import type { UpstreamChatRequest } from '../src/workbuddy/request-mapper.js';

const body: UpstreamChatRequest = {
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'system', content: 'x' }],
  stream: true,
};

const doneSse = 'data: {"id":"cmb-ok","choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":null}\n\ndata: [DONE]\n';

function client(fetchFn: typeof fetch): WorkBuddyClient {
  return new WorkBuddyClient({
    upstreamUrl: 'https://mock.invalid/chat',
    credentials: {
      getCredential: async () => ({ accessToken: 'token', userId: 'user', domain: 'www.workbuddy.ai' }),
      invalidate: vi.fn(),
      describe: () => 'mock',
    },
    userAgent: 'test/1',
    fetchFn,
  });
}

describe('transient upstream gateway retry', () => {
  it.each([502, 503, 504])('retries HTTP %s once before returning the stream', async (status) => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response('temporary', { status });
      return new Response(doneSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const stream = await client(fetchFn).streamChatCompletion(body, new AbortController().signal);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(chunks.some((chunk) => chunk.delta.content === 'OK')).toBe(true);
  });

  it('surfaces the second gateway failure without retrying indefinitely', async () => {
    const fetchFn = vi.fn(async () => new Response('still down', { status: 502 })) as unknown as typeof fetch;

    await expect(
      client(fetchFn).streamChatCompletion(body, new AbortController().signal),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient client errors', async () => {
    const fetchFn = vi.fn(async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch;

    await expect(
      client(fetchFn).streamChatCompletion(body, new AbortController().signal),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { createToolCallTracer } from '../src/observability/tool-trace.js';
import type { UpstreamChunk } from '../src/workbuddy/client.js';

const PATH = '/tmp/wkb-tool-trace-test.jsonl';

function chunk(toolCalls: UpstreamChunk['delta']['tool_calls'], finish: string | null = null): UpstreamChunk {
  return { id: 'cmb-1', delta: { tool_calls: toolCalls }, finish_reason: finish, usage: null };
}

describe('ToolCallTracer', () => {
  it('records upstream and downstream tool-call frames as JSONL', async () => {
    await rm(PATH, { force: true });
    const tracer = createToolCallTracer(PATH);

    tracer.upstream('req-1', chunk([{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }]));
    tracer.upstream('req-1', chunk([{ index: 0, function: { arguments: '{"city"' } }]));
    tracer.downstream('req-1', [{ index: 0, function: { arguments: '{"city"' } }]);
    tracer.aggregate('req-1', [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }]);

    // Writes are queued; poll briefly rather than assuming immediate flush.
    let lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      try {
        lines = (await readFile(PATH, 'utf8')).trim().split('\n').filter(Boolean);
      } catch {
        lines = [];
      }
      if (lines.length >= 4) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(lines).toHaveLength(4);
    const entries = lines.map((l) => JSON.parse(l));
    expect(entries.map((e) => e.direction)).toEqual(['upstream', 'upstream', 'downstream', 'aggregate']);
    // The raw argument fragment is preserved verbatim — this is the payload
    // that distinguishes parser mismatch from streaming truncation.
    expect(entries[1].tool_calls[0].function.arguments).toBe('{"city"');
    expect(entries[3].tool_calls[0].function.arguments).toBe('{"city":"Tokyo"}');

    await rm(PATH, { force: true });
  });

  it('is inert when disabled', async () => {
    const tracer = createToolCallTracer('');
    expect(tracer.enabled).toBe(false);
    tracer.upstream('req-2', chunk([{ index: 0, id: 'call_x', function: { name: 'f', arguments: '{}' } }]));
    tracer.aggregate('req-2', []);
    // No throw, no file: disabled tracing must never affect request handling.
  });
});

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UpstreamChunk } from '../workbuddy/client.js';

/**
 * Append-only trace of raw upstream tool-call frames.
 *
 * Tool-call bugs are nearly impossible to diagnose after the fact: by the time
 * a client reports "empty arguments" the raw deltas are gone. This module
 * records exactly what upstream sent and what the gateway emitted, so the
 * three candidate causes (parser mismatch, streaming truncation, bad fallback)
 * can be told apart from a single log line.
 *
 * Traces are written as JSONL and never contain credentials: only tool-call
 * shape is recorded, and values pass through redact().
 */

export const TRACE_DISABLED = '';

export class ToolCallTracer {
  private queue: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly path: string) {}

  get enabled(): boolean {
    return this.path !== TRACE_DISABLED;
  }

  /** Record one upstream frame that carried tool_calls. */
  upstream(id: string, chunk: UpstreamChunk): void {
    if (!this.enabled || !chunk.delta.tool_calls?.length) return;
    this.write({
      direction: 'upstream',
      request_id: id,
      finish_reason: chunk.finish_reason,
      tool_calls: chunk.delta.tool_calls,
    });
  }

  /** Record one tool_call delta the gateway forwarded to the client. */
  downstream(id: string, toolCalls: unknown): void {
    if (!this.enabled) return;
    this.write({ direction: 'downstream', request_id: id, tool_calls: toolCalls });
  }

  /** Record the aggregated non-stream tool calls actually returned. */
  aggregate(id: string, toolCalls: unknown): void {
    if (!this.enabled) return;
    this.write({ direction: 'aggregate', request_id: id, tool_calls: toolCalls });
  }

  private write(entry: Record<string, unknown>): void {
    if (this.failed) return;
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n';
    // Serialize appends so concurrent requests cannot interleave partial lines.
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 });
      })
      .catch(() => {
        // Tracing must never break a request path; disable on first failure.
        this.failed = true;
      });
  }
}

export function createToolCallTracer(path: string): ToolCallTracer {
  return new ToolCallTracer(path);
}

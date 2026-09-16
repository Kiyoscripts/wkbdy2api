import { z } from 'zod';

export const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export const thinkingSchema = z.union([
  reasoningEffortSchema,
  z.object({ type: z.literal('adaptive') }).strict(),
  z.object({ type: z.literal('disabled') }).strict(),
  z.object({ type: z.literal('enabled'), budget_tokens: z.number().int().positive().optional() }).strict(),
  z.object({ effort: reasoningEffortSchema }).strict(),
]);

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type Thinking = z.infer<typeof thinkingSchema>;

export function mapThinkingToReasoningEffort(thinking: Thinking, fallback: ReasoningEffort = 'high'): ReasoningEffort {
  if (typeof thinking === 'string') return thinking;
  if ('effort' in thinking) return thinking.effort;
  if (thinking.type === 'disabled') return 'none';
  if (thinking.type === 'adaptive') return fallback;
  if (thinking.budget_tokens === undefined) return fallback;
  return thinking.budget_tokens >= 32768
    ? 'xhigh'
    : thinking.budget_tokens >= 8192
      ? 'high'
      : thinking.budget_tokens >= 2048
        ? 'medium'
        : 'low';
}

export function normalizeOpenAiRequestBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out = { ...(body as Record<string, unknown>) };
  const optionalKeys = [
    'user', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop',
    'thinking', 'reasoning_effort', 'response_format', 'frequency_penalty',
    'presence_penalty', 'seed', 'service_tier', 'serviceTier', 'verbosity',
    'tools', 'tool_choice', 'parallel_tool_calls', 'stream_options', 'metadata',
    'logprobs', 'top_logprobs', 'web_search_options', 'store', 'logit_bias',
    'functions', 'function_call', 'audio', 'modalities', 'prediction', 'speed',
  ];
  for (const key of optionalKeys) if (out[key] === '[undefined]') delete out[key];
  if (out.stream_options && typeof out.stream_options === 'object' && !Array.isArray(out.stream_options)) {
    const streamOptions = { ...(out.stream_options as Record<string, unknown>) };
    if (streamOptions.include_usage === '[undefined]') delete streamOptions.include_usage;
    out.stream_options = streamOptions;
  }
  return out;
}

/**
 * Downstream (OpenAI) chat request schema. Only the fields the first version
 * supports are declared; unknown-but-semantics-changing fields are rejected
 * explicitly in the route (strict passthrough policy per plan).
 */
export const chatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z
      .array(
        z.object({
          role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
          // OpenAI represents assistant tool-call messages with null content.
          content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
          name: z.string().optional(),
          tool_calls: z.array(z.any()).optional(),
          tool_call_id: z.string().optional(),
        }),
      )
      .min(1, 'messages must contain at least one message'),
    stream: z.boolean().default(false),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
    tools: z
      .array(
        z.object({
          type: z.literal('function'),
          function: z.object({
            name: z.string().min(1),
            description: z.string().optional(),
            parameters: z.record(z.any()).optional(),
          }),
        }),
      )
      .optional(),
    tool_choice: z
      .union([z.enum(['none', 'auto', 'required']), z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) })])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
    // Both OpenAI-style strings and common object forms map to WorkBuddy's top-level reasoning_effort.
    reasoning_effort: reasoningEffortSchema.optional(),
    thinking: thinkingSchema.optional(),
    user: z.string().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    // OpenAI-compatible clients may send this persistence hint. WorkBuddy
    // does not support server-side response storage, so accept it for
    // compatibility but intentionally do not forward it upstream.
    store: z.boolean().optional(),
  })
  // Not .strict(): the route applies an accept-and-drop policy for unknown
  // fields, and Zod strips unrecognized keys before that policy can report
  // them. Semantic-changing fields are rejected explicitly in the route.
  .passthrough();

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/**
 * Upstream request builder (OpenAI shape, with the two WorkBuddy quirks from
 * the M2 protocol capture applied):
 *  - upstream rejects stream:false (400 code:11101) → always stream:true
 *  - messages[0] must be system (400 code:11128) → inject a default when absent
 */
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

export type UpstreamChatRequest = {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  stream: true;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};

export function toUpstreamRequest(req: ChatRequest): UpstreamChatRequest {
  const out: UpstreamChatRequest = {
    model: req.model,
    messages: normalizeMessages(req.messages),
    stream: true,
  };
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.max_tokens !== undefined) out.max_tokens = req.max_tokens;
  else if (req.max_completion_tokens !== undefined) out.max_tokens = req.max_completion_tokens;
  if (req.stop !== undefined) out.stop = req.stop;
  if (req.tools !== undefined) out.tools = req.tools;
  if (req.tool_choice !== undefined) out.tool_choice = req.tool_choice;
  if (req.parallel_tool_calls !== undefined) out.parallel_tool_calls = req.parallel_tool_calls;
  if (req.thinking !== undefined) out.reasoning_effort = mapThinkingToReasoningEffort(req.thinking, req.reasoning_effort);
  else if (req.reasoning_effort !== undefined) out.reasoning_effort = req.reasoning_effort;
  return out;
}

/**
 * Ensure messages[0] is system. 'developer' is treated as a system prompt by
 * the upstream; if neither a system nor developer message leads, a default
 * system message is injected. Everything else passes through unchanged.
 */
export function normalizeMessages(
  messages: ChatRequest['messages'],
): UpstreamChatRequest['messages'] {
  const mapped = messages.map((m) => ({
    role: m.role === 'developer' ? 'system' : m.role,
    content: m.content,
    ...(m.tool_calls !== undefined ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.name !== undefined ? { name: m.name } : {}),
  }));
  if (mapped.length === 0 || mapped[0]!.role !== 'system') {
    return [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }, ...mapped];
  }
  return mapped;
}

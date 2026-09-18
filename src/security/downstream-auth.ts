import { timingSafeEqual } from 'node:crypto';

/**
 * Downstream API key check. Constant-time comparison; the key never appears
 * in logs or error messages.
 */
export function isApiKeyValid(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type ApiKeyHeaders = {
  authorization?: string | string[];
  'x-api-key'?: string | string[];
  'api-key'?: string | string[];
};

export type ExtractedApiKey = {
  value?: string;
  conflicting: boolean;
  sources: string[];
};

/**
 * Normalize common OpenAI/Anthropic/Azure-style API-key headers.
 * Values are trimmed and Bearer matching is case-insensitive. Multiple
 * identical headers are accepted; different values are rejected as ambiguous.
 */
export function extractApiKey(headers: ApiKeyHeaders): ExtractedApiKey {
  const candidates: Array<{ source: string; value: string }> = [];
  const first = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim();

  const authorization = first(headers.authorization);
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (match?.[1]?.trim()) candidates.push({ source: 'authorization', value: match[1].trim() });
  }
  const xApiKey = first(headers['x-api-key']);
  if (xApiKey) candidates.push({ source: 'x-api-key', value: xApiKey });
  const apiKey = first(headers['api-key']);
  if (apiKey) candidates.push({ source: 'api-key', value: apiKey });

  const values = new Set(candidates.map((candidate) => candidate.value));
  return {
    value: candidates[0]?.value,
    conflicting: values.size > 1,
    sources: candidates.map((candidate) => candidate.source),
  };
}

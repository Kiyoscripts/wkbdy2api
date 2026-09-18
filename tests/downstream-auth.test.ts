import { describe, expect, it } from 'vitest';
import { extractApiKey, isApiKeyValid } from '../src/security/downstream-auth.js';

describe('downstream API-key normalization', () => {
  it.each([
    [{ authorization: 'Bearer secret-value' }, 'secret-value', ['authorization']],
    [{ authorization: 'bearer   secret-value  ' }, 'secret-value', ['authorization']],
    [{ 'x-api-key': '  secret-value  ' }, 'secret-value', ['x-api-key']],
    [{ 'api-key': 'secret-value' }, 'secret-value', ['api-key']],
  ] as const)('extracts supported header variants', (headers, value, sources) => {
    expect(extractApiKey(headers)).toEqual({ value, conflicting: false, sources });
  });

  it('allows matching duplicate credentials and rejects different ones', () => {
    expect(extractApiKey({ authorization: 'Bearer same', 'x-api-key': 'same' })).toEqual({
      value: 'same', conflicting: false, sources: ['authorization', 'x-api-key'],
    });
    expect(extractApiKey({ authorization: 'Bearer first', 'x-api-key': 'second' }).conflicting).toBe(true);
  });

  it('does not treat Basic or malformed authorization as an API key', () => {
    expect(extractApiKey({ authorization: 'Basic abc' })).toEqual({ value: undefined, conflicting: false, sources: [] });
    expect(extractApiKey({ authorization: 'Bearer   ' })).toEqual({ value: undefined, conflicting: false, sources: [] });
  });

  it('checks normalized values without accepting prefixes or suffixes', () => {
    expect(isApiKeyValid('correct-key', 'correct-key')).toBe(true);
    expect(isApiKeyValid('correct-key ', 'correct-key')).toBe(false);
    expect(isApiKeyValid('Bearer correct-key', 'correct-key')).toBe(false);
  });
});

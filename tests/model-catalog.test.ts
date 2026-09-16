import { describe, expect, it } from 'vitest';
import { parseProductConfig, buildCatalog, ConfigParseError } from '../src/workbuddy/model-catalog.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalogFixture } from './helpers/catalog-fixture.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const live = loadCatalogFixture();

describe('parseProductConfig with live snapshot', () => {
  it('parses the real snapshot', () => {
    const cfg = parseProductConfig(live);
    expect(cfg.data.models).toHaveLength(21);
  });

  it('rejects duplicate model ids', () => {
    const bad = structuredClone(live);
    bad.data.models[1].id = bad.data.models[0].id;
    expect(() => parseProductConfig(bad)).toThrow(ConfigParseError);
  });

  it('rejects missing models array', () => {
    expect(() => parseProductConfig({ data: { models: [], agents: live.data.agents } })).toThrow();
  });
});

describe('buildCatalog with live snapshot', () => {
  it('exposes exactly the 20 CLI whitelist models', () => {
    const catalog = buildCatalog(parseProductConfig(live));
    expect(catalog).toHaveLength(20);
    const wl = new Set(live.data.agents.find((a: { name: string }) => a.name === 'cli')!.models);
    for (const m of catalog) expect(wl.has(m.id)).toBe(true);
  });

  it('does not expose hy4-preview (outside whitelist)', () => {
    const catalog = buildCatalog(parseProductConfig(live));
    expect(catalog.find((m) => m.id === 'hy4-preview')).toBeUndefined();
  });

  it('keeps whitelist order and marks default-model', () => {
    const catalog = buildCatalog(parseProductConfig(live));
    expect(catalog[0]!.id).toBe('default-model');
    expect(catalog[0]!.x_workbuddy.is_default).toBe(true);
  });

  it('produces OpenAI-shaped model objects', () => {
    const catalog = buildCatalog(parseProductConfig(live));
    const m = catalog[0]!;
    expect(m.object).toBe('model');
    expect(m.owned_by).toBe('workbuddy');
    expect(m.created).toBe(0);
    expect(m.x_workbuddy.max_input_tokens).toBeGreaterThan(0);
  });

  it('preserves reasoning metadata and contextWindow.supportedLengths', () => {
    const catalog = buildCatalog(parseProductConfig(live));
    const model = catalog.find((m) => m.id === 'gpt-6-astra')!;
    expect(model.x_workbuddy.supports_reasoning).toBe(true);
    expect(model.x_workbuddy.only_reasoning).toBe(true);
    expect(model.x_workbuddy.reasoning?.supportedEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(model.x_workbuddy.context_window).toEqual({
      defaultLength: 400000,
      supportedLengths: [400000, 1000000],
    });
  });
});

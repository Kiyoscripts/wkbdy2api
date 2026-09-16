import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this helper (tests/helpers/ → ../..). */
export const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Load the model catalog fixture for tests.
 *
 * `wb_v3config_live.json` is a real (gitignored) product capture and is
 * preferred when present. In a clean checkout it does not exist, which used
 * to fail four suites outright. Fall back to the committed public config so
 * `pnpm test` is green out of the box.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadCatalogFixture(): any {
  const livePath = `${projectRoot}/wb_v3config_live.json`;
  const publicPath = `${projectRoot}/wb_v3config.public.json`;
  const path = existsSync(livePath) ? livePath : publicPath;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readFixture(name: string): string {
  return readFileSync(`${projectRoot}/fixtures/${name}`, 'utf8');
}

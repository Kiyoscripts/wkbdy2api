import { z } from 'zod';

const envSchema = z.object({
  /** Loopback bind address. Only override for controlled testing. */
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7891),
  /** Local API key required from all downstream callers. No default: refuse to run without it. */
  WKB2API_API_KEY: z.string().min(16, 'WKB2API_API_KEY must be at least 16 chars'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  /** Upstream override (defaults to the verified WorkBuddy endpoint). */
  WKB2API_UPSTREAM_URL: z.string().url().default('https://www.workbuddy.ai/v2/chat/completions'),
  /** Upstream User-Agent. Upstream enforces single-segment 'name/version'. */
  WKB2API_UPSTREAM_UA: z.string().default('WorkBuddy/2.137.1'),
  /** Timeouts (ms). */
  WKB2API_FIRST_BYTE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  WKB2API_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  /** Encrypted OAuth account store and its independent 32-byte key file. */
  WKB2API_ACCOUNT_STORE_PATH: z.string().default('data/accounts.enc'),
  WKB2API_ACCOUNT_STORE_KEY_FILE: z.string().min(1),
  /** Local WorkBuddy credential file used only by the admin import endpoint. */
  WKB2API_CREDENTIALS_PATH: z.string().optional(),
  /** JSONL path for raw tool-call frame tracing. Empty string disables it. */
  WKB2API_TOOL_TRACE_PATH: z.string().default('data/tool-calls.jsonl'),
  WKB2API_MODEL_ALIASES: z.string().default('{}').transform((raw, ctx) => {
    try {
      const aliases = z.record(z.string().min(1)).parse(JSON.parse(raw));
      return aliases;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a JSON object mapping aliases to gateway model IDs' });
      return z.NEVER;
    }
  }),
});

export type AppConfig = {
  host: string;
  port: number;
  apiKey: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug';
  upstreamUrl: string;
  upstreamUa: string;
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
  accountStorePath: string;
  accountStoreKeyFile: string;
  credentialsPath: string;
  modelAliases: Record<string, string>;
  toolTracePath: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return {
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    apiKey: parsed.data.WKB2API_API_KEY,
    logLevel: parsed.data.LOG_LEVEL,
    upstreamUrl: parsed.data.WKB2API_UPSTREAM_URL,
    upstreamUa: parsed.data.WKB2API_UPSTREAM_UA,
    firstByteTimeoutMs: parsed.data.WKB2API_FIRST_BYTE_TIMEOUT_MS,
    idleTimeoutMs: parsed.data.WKB2API_IDLE_TIMEOUT_MS,
    accountStorePath: parsed.data.WKB2API_ACCOUNT_STORE_PATH,
    accountStoreKeyFile: parsed.data.WKB2API_ACCOUNT_STORE_KEY_FILE,
    credentialsPath: parsed.data.WKB2API_CREDENTIALS_PATH ?? 'workbuddy-desktop-ai.info',
    modelAliases: parsed.data.WKB2API_MODEL_ALIASES,
    toolTracePath: parsed.data.WKB2API_TOOL_TRACE_PATH,
  };
}

import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Scopes a caller can hold. Read tools need `read`; tools that change data need `write`. */
export const SCOPES = ['read', 'write'] as const;
export type Scope = (typeof SCOPES)[number];

/** An API token from configuration. Only its SHA-256 digest is kept in memory after start-up. */
export interface ApiTokenConfig {
  name: string;
  token: string;
  scopes: Scope[];
}

export interface AppConfig {
  databasePath: string;
  apiTokens: ApiTokenConfig[];
  stdio: { actor: string; scopes: Scope[] };
  http: { host: string; port: number; allowedHosts?: string[] };
  rateLimitPerMinute: number;
  confirmTtlSeconds: number;
}

/** Project root, resolved from this file so it works from both `src/` (tsx) and `dist/` (node). */
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const scopeList = z
  .string()
  .transform((value) => value.split(/[\s,|+]+/).filter(Boolean))
  .pipe(z.array(z.enum(SCOPES)).min(1));

/**
 * Parses `API_TOKENS`, a comma-separated list of `name:token:scopes` entries.
 * Scopes inside one entry are joined with `|` or `+`, for example:
 *
 *   API_TOKENS=analyst:3f9c...e1:read,ops-bot:a71d...9b:read|write
 */
export function parseApiTokens(raw: string | undefined): ApiTokenConfig[] {
  if (!raw?.trim()) return [];
  const tokens = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const [name, token, scopes, ...rest] = entry.split(':');
      if (!name || !token || !scopes || rest.length > 0) {
        throw new Error(`API_TOKENS entry #${index + 1} must look like name:token:scopes`);
      }
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
        throw new Error(`API_TOKENS entry #${index + 1}: invalid token name "${name}"`);
      }
      if (token.length < 16) {
        throw new Error(`API_TOKENS entry "${name}": token must be at least 16 characters`);
      }
      const parsed = scopeList.safeParse(scopes);
      if (!parsed.success) {
        throw new Error(`API_TOKENS entry "${name}": scopes must be read and/or write`);
      }
      return { name, token, scopes: [...new Set(parsed.data)] };
    });

  const names = new Set(tokens.map((t) => t.name));
  if (names.size !== tokens.length) throw new Error('API_TOKENS contains duplicate token names');
  return tokens;
}

const envSchema = z.object({
  DATABASE_PATH: z.string().min(1).optional(),
  API_TOKENS: z.string().optional(),
  STDIO_ACTOR: z.string().min(1).max(64).default('stdio'),
  STDIO_SCOPES: scopeList.default(['read']),
  HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  ALLOWED_HOSTS: z
    .string()
    .optional()
    .transform((value) =>
      value
        ?.split(',')
        .map((host) => host.trim())
        .filter(Boolean),
    ),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  CONFIRM_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    databasePath: e.DATABASE_PATH ?? `${PROJECT_ROOT}data/store.db`,
    apiTokens: parseApiTokens(e.API_TOKENS),
    stdio: { actor: e.STDIO_ACTOR, scopes: [...new Set(e.STDIO_SCOPES)] },
    http: {
      host: e.HTTP_HOST,
      port: e.HTTP_PORT,
      allowedHosts: e.ALLOWED_HOSTS?.length ? e.ALLOWED_HOSTS : undefined,
    },
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    confirmTtlSeconds: e.CONFIRM_TTL_SECONDS,
  };
}

/**
 * GASTOWN WHITE-LABEL CONFIGURATION
 *
 * Customize branding, LLM provider, database, and capabilities.
 * All values can be overridden via environment variables.
 */

export interface GasTownConfig {
  /** Display name for the platform */
  name: string;
  /** Logo URL */
  logo: string;
  /** Theme colors */
  theme: {
    primary: string;
    background: string;
    surface: string;
    text: string;
    accent: string;
  };
  /** LLM provider configuration */
  llm: {
    provider: 'gemini' | 'openai' | 'anthropic' | 'openrouter';
    model: string;
    endpoint: string;
    apiKey?: string;
  };
  /** Database configuration */
  database: {
    provider: 'postgresql';
    url: string;
  };
  /** System capacity limits */
  capabilities: {
    maxPolecats: number;
    maxConcurrentMolecules: number;
    wispTTLSeconds: number;
    budgetDailyUSD: number;
    maxWorkers: number;
  };
  /** Extension system */
  extensions: {
    enableBuiltinPlugins: boolean;
    customPluginDirs: string[];
  };
  /** SSE broadcast */
  sse: {
    enabled: boolean;
    heartbeatMs: number;
  };
}

export const defaultConfig: GasTownConfig = {
  name: process.env.GASTOWN_NAME ?? 'Gas Town',
  logo: process.env.GASTOWN_LOGO ?? '/logo.svg',
  theme: {
    primary: '#e94560',
    background: '#0d1117',
    surface: '#161b22',
    text: '#c9d1d9',
    accent: '#58a6ff',
  },
  llm: {
    provider: (process.env.LLM_PROVIDER as GasTownConfig['llm']['provider']) ?? 'gemini',
    model: process.env.LLM_MODEL ?? 'gemini-2.0-flash',
    endpoint: process.env.LLM_ENDPOINT ?? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey: process.env.LLM_API_KEY ?? process.env.GEMINI_API_KEY,
  },
  database: {
    provider: 'postgresql',
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/gastown',
  },
  capabilities: {
    maxPolecats: Number(process.env.MAX_POLECATS) || 10,
    maxConcurrentMolecules: Number(process.env.MAX_MOLECULES) || 50,
    wispTTLSeconds: Number(process.env.WISP_TTL) || 3600,
    budgetDailyUSD: Number(process.env.DAILY_BUDGET) || 50,
    maxWorkers: Number(process.env.MAX_WORKERS) || 20,
  },
  extensions: {
    enableBuiltinPlugins: process.env.ENABLE_BUILTIN_PLUGINS !== 'false',
    customPluginDirs: process.env.CUSTOM_PLUGIN_DIRS?.split(',') ?? [],
  },
  sse: {
    enabled: process.env.SSE_ENABLED !== 'false',
    heartbeatMs: Number(process.env.SSE_HEARTBEAT_MS) || 30000,
  },
};

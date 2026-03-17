/**
 * MAESTRO — Agent Registry
 *
 * Multi-agent provider registry supporting Claude Code, Codex, Gemini CLI,
 * OpenCode, Aider, and Factory Droid. Each agent definition encodes the CLI
 * binary, batch/resume/yolo args, output format, and capability matrix.
 *
 * Gas Town: "Every rig has a driver. Every driver has a manual."
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../lib/logger';

const execFileAsync = promisify(execFile);
const log = createLogger('maestro:agent-registry');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentCapabilities {
  supportsResume: boolean;
  supportsBatchMode: boolean;
  supportsImageInput: boolean;
  supportsCostTracking: boolean;
  supportsSessionStorage: boolean;
  supportsStreaming: boolean;
  supportsWorktree: boolean;
}

export interface AgentDefinition {
  id: string;
  displayName: string;
  binary: string;
  batchArgs: string[];
  outputFormat: 'stream-json' | 'jsonl' | 'text';
  resumeArgs?: (sessionId: string) => string[];
  modelArgs?: (model: string) => string[];
  yoloArgs?: string[];
  capabilities: AgentCapabilities;
}

export interface DetectedAgent {
  definition: AgentDefinition;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  detectedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Definitions — all 6 providers
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    binary: 'claude',
    batchArgs: ['--print', '--output-format', 'stream-json'],
    outputFormat: 'stream-json',
    resumeArgs: (sessionId: string) => ['--resume', sessionId],
    modelArgs: (model: string) => ['--model', model],
    yoloArgs: ['--dangerously-skip-permissions'],
    capabilities: {
      supportsResume: true,
      supportsBatchMode: true,
      supportsImageInput: true,
      supportsCostTracking: true,
      supportsSessionStorage: true,
      supportsStreaming: true,
      supportsWorktree: true,
    },
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    binary: 'codex',
    batchArgs: ['--quiet', '--approval-mode', 'full-auto'],
    outputFormat: 'jsonl',
    resumeArgs: undefined,
    modelArgs: (model: string) => ['--model', model],
    yoloArgs: ['--approval-mode', 'full-auto'],
    capabilities: {
      supportsResume: false,
      supportsBatchMode: true,
      supportsImageInput: false,
      supportsCostTracking: true,
      supportsSessionStorage: false,
      supportsStreaming: true,
      supportsWorktree: true,
    },
  },
  {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    binary: 'gemini',
    batchArgs: ['--non-interactive'],
    outputFormat: 'text',
    resumeArgs: (sessionId: string) => ['--session', sessionId],
    modelArgs: (model: string) => ['--model', model],
    yoloArgs: ['--sandbox', 'none'],
    capabilities: {
      supportsResume: true,
      supportsBatchMode: true,
      supportsImageInput: true,
      supportsCostTracking: false,
      supportsSessionStorage: true,
      supportsStreaming: true,
      supportsWorktree: true,
    },
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    binary: 'opencode',
    batchArgs: ['run'],
    outputFormat: 'text',
    resumeArgs: undefined,
    modelArgs: (model: string) => ['--model', model],
    yoloArgs: ['--auto-approve'],
    capabilities: {
      supportsResume: false,
      supportsBatchMode: true,
      supportsImageInput: false,
      supportsCostTracking: false,
      supportsSessionStorage: false,
      supportsStreaming: false,
      supportsWorktree: true,
    },
  },
  {
    id: 'aider',
    displayName: 'Aider',
    binary: 'aider',
    batchArgs: ['--yes-always', '--no-git'],
    outputFormat: 'text',
    resumeArgs: undefined,
    modelArgs: (model: string) => ['--model', model],
    yoloArgs: ['--yes-always'],
    capabilities: {
      supportsResume: false,
      supportsBatchMode: true,
      supportsImageInput: true,
      supportsCostTracking: true,
      supportsSessionStorage: false,
      supportsStreaming: true,
      supportsWorktree: true,
    },
  },
  {
    id: 'factory-droid',
    displayName: 'Factory Droid',
    binary: 'factory',
    batchArgs: ['exec', '--non-interactive'],
    outputFormat: 'jsonl',
    resumeArgs: (sessionId: string) => ['--resume', sessionId],
    modelArgs: (model: string) => ['--provider-model', model],
    yoloArgs: ['--auto-approve'],
    capabilities: {
      supportsResume: true,
      supportsBatchMode: true,
      supportsImageInput: false,
      supportsCostTracking: true,
      supportsSessionStorage: true,
      supportsStreaming: true,
      supportsWorktree: true,
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// In-memory cache of detection results
// ─────────────────────────────────────────────────────────────────────────────

const detectedAgents = new Map<string, DetectedAgent>();
let lastDetection: Date | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Detection helpers
// ─────────────────────────────────────────────────────────────────────────────

async function probeBinary(binary: string): Promise<{ path?: string; version?: string }> {
  try {
    const { stdout: whichOut } = await execFileAsync('which', [binary], { timeout: 5000 });
    const binaryPath = whichOut.trim();
    if (!binaryPath) return {};

    let version: string | undefined;
    try {
      const { stdout: versionOut } = await execFileAsync(binary, ['--version'], {
        timeout: 10000,
      });
      const match = versionOut.match(/(\d+\.\d+[.\d]*)/);
      version = match?.[1];
    } catch {
      // --version not supported — binary still found
    }

    return { path: binaryPath, version };
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probe PATH for all known agent binaries. Results are cached in memory
 * and refreshed on explicit call to `detectInstalledAgents()`.
 */
export async function detectInstalledAgents(): Promise<DetectedAgent[]> {
  log.info('Detecting installed agents...');
  const results: DetectedAgent[] = [];

  const probes = AGENT_DEFINITIONS.map(async (def) => {
    const { path, version } = await probeBinary(def.binary);
    const detected: DetectedAgent = {
      definition: def,
      installed: !!path,
      binaryPath: path,
      version,
      detectedAt: new Date(),
    };
    detectedAgents.set(def.id, detected);
    results.push(detected);

    if (path) {
      log.info({ agent: def.id, path, version }, `Agent detected: ${def.displayName}`);
    } else {
      log.debug({ agent: def.id }, `Agent not found: ${def.displayName}`);
    }
  });

  await Promise.all(probes);
  lastDetection = new Date();
  log.info({ count: results.filter((r) => r.installed).length }, 'Agent detection complete');
  return results;
}

/**
 * Get agent definition by ID. Returns undefined if not a known agent.
 */
export function getAgentDefinition(id: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS.find((d) => d.id === id);
}

/**
 * Get cached detection result for an agent. Includes install status.
 */
export function getDetectedAgent(id: string): DetectedAgent | undefined {
  return detectedAgents.get(id);
}

/**
 * List all known agent definitions.
 */
export function listAgents(): AgentDefinition[] {
  return [...AGENT_DEFINITIONS];
}

/**
 * List only agents that have been detected as installed.
 */
export function listInstalledAgents(): DetectedAgent[] {
  return Array.from(detectedAgents.values()).filter((a) => a.installed);
}

/**
 * Get the default agent. Preference order: claude-code > codex > gemini-cli > first installed.
 * Falls back to claude-code definition even if not installed.
 */
export function getDefaultAgent(): AgentDefinition {
  const preference = ['claude-code', 'codex', 'gemini-cli'];
  for (const id of preference) {
    const detected = detectedAgents.get(id);
    if (detected?.installed) return detected.definition;
  }

  // Fall back to any installed agent
  const anyInstalled = listInstalledAgents();
  if (anyInstalled.length > 0) return anyInstalled[0].definition;

  // Ultimate fallback — return claude-code definition
  return AGENT_DEFINITIONS[0];
}

/**
 * Build the full CLI argument array for dispatching a task to an agent.
 */
export function buildAgentArgs(
  agent: AgentDefinition,
  opts: {
    prompt: string;
    model?: string;
    yolo?: boolean;
    resumeSession?: string;
    extraArgs?: string[];
  },
): string[] {
  const args: string[] = [];

  // Batch mode args
  args.push(...agent.batchArgs);

  // YOLO / auto-approve
  if (opts.yolo && agent.yoloArgs) {
    args.push(...agent.yoloArgs);
  }

  // Model override
  if (opts.model && agent.modelArgs) {
    args.push(...agent.modelArgs(opts.model));
  }

  // Resume session
  if (opts.resumeSession && agent.resumeArgs) {
    args.push(...agent.resumeArgs(opts.resumeSession));
  }

  // Extra args
  if (opts.extraArgs) {
    args.push(...opts.extraArgs);
  }

  // Prompt goes last (for agents that take it as a positional arg)
  args.push(opts.prompt);

  return args;
}

/**
 * Get detection cache age in milliseconds. Returns -1 if never detected.
 */
export function getDetectionAge(): number {
  if (!lastDetection) return -1;
  return Date.now() - lastDetection.getTime();
}

/**
 * Auto-detect on first access if cache is empty or stale (>5 min).
 */
export async function ensureDetected(): Promise<void> {
  const age = getDetectionAge();
  if (age < 0 || age > 5 * 60 * 1000) {
    await detectInstalledAgents();
  }
}

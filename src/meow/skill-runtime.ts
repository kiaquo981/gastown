/**
 * SkillRuntime — EP-103
 *
 * Execution engine for skills. Routes to the correct runtime based on
 * the skill manifest's `runtime` field.
 *
 * Runtimes:
 *   prompt_only — LLM call with system prompt + tools description
 *   builtin     — Hardcoded TypeScript function
 *   node        — Evaluate a Node.js entry script (sandboxed)
 *   python      — Future: subprocess call
 *   wasm        — Future: WASM module execution
 */

import { createLogger } from '../lib/logger';
import { broadcast } from '../sse';
import { getSkill } from './skill-registry';
import type { SkillManifest, SkillRuntime as SkillRuntimeType } from './types';

const log = createLogger('skill-runtime');

// ─────────────────────────────────────────────────────────────────────────────
// Execution Context
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillExecContext {
  moleculeId: string;
  stepId: string;
  stepName: string;
  inputs: Record<string, unknown>;
  /** Variables from formula vars + molecule metadata */
  vars?: Record<string, unknown>;
  /** Agent tier executing the skill */
  tier?: 'S' | 'A' | 'B';
}

export interface SkillExecResult {
  success: boolean;
  outputs: Record<string, unknown>;
  logs: string[];
  durationMs: number;
  runtime: SkillRuntimeType;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Builtin Skills Registry
// ─────────────────────────────────────────────────────────────────────────────

type BuiltinHandler = (ctx: SkillExecContext) => Promise<Record<string, unknown>>;

const builtins = new Map<string, BuiltinHandler>();

export function registerBuiltin(name: string, handler: BuiltinHandler): void {
  builtins.set(name, handler);
  log.info({ name }, 'Builtin skill handler registered');
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Builtin Skills
// ─────────────────────────────────────────────────────────────────────────────

// pass-through — does nothing, just passes
registerBuiltin('noop', async () => ({ result: 'ok' }));

// echo — returns inputs as outputs
registerBuiltin('echo', async (ctx) => ({ ...ctx.inputs }));

// delay — waits for N seconds
registerBuiltin('delay', async (ctx) => {
  const seconds = Number(ctx.inputs.seconds || 1);
  await new Promise(r => setTimeout(r, seconds * 1000));
  return { waited: seconds };
});

// aggregate — collects inputs into a summary object
registerBuiltin('aggregate', async (ctx) => {
  return {
    summary: `Aggregated ${Object.keys(ctx.inputs).length} inputs`,
    keys: Object.keys(ctx.inputs),
    data: ctx.inputs,
  };
});

// validate — checks required fields exist in inputs
registerBuiltin('validate', async (ctx) => {
  const required = (ctx.inputs.required_fields as string[]) || [];
  const data = (ctx.inputs.data || ctx.inputs) as Record<string, unknown>;
  const missing = required.filter(f => !(f in data));
  return {
    valid: missing.length === 0,
    missing,
    checked: required.length,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// LLM Integration for prompt_only runtime
// ─────────────────────────────────────────────────────────────────────────────

async function callLLM(systemPrompt: string, userMessage: string, model: string = 'gemini-2.0-flash'): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return `[LLM unavailable — no GEMINI_API_KEY] Simulated response for: ${userMessage.slice(0, 100)}`;
  }

  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          max_tokens: 4096,
          temperature: 0.7,
        }),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      log.warn({ status: resp.status, body: text.slice(0, 200) }, 'LLM call failed');
      return `[LLM error ${resp.status}] Simulated response`;
    }

    const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    log.error({ err }, 'LLM call exception');
    return `[LLM exception] Simulated response`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime Dispatch
// ─────────────────────────────────────────────────────────────────────────────

export async function executeSkill(skillName: string, ctx: SkillExecContext): Promise<SkillExecResult> {
  const skill = getSkill(skillName);
  if (!skill) {
    return {
      success: false,
      outputs: {},
      logs: [`Skill "${skillName}" not found in registry`],
      durationMs: 0,
      runtime: 'builtin',
      error: `Skill not found: ${skillName}`,
    };
  }

  const start = Date.now();
  const logs: string[] = [];

  logs.push(`Executing skill: ${skillName} (runtime: ${skill.runtime})`);

  broadcast('meow:skills', {
    type: 'skill_exec_start',
    skill: skillName,
    moleculeId: ctx.moleculeId,
    stepId: ctx.stepId,
    runtime: skill.runtime,
  });

  let result: SkillExecResult;

  try {
    switch (skill.runtime) {
      case 'builtin':
        result = await executeBuiltin(skill, ctx, logs);
        break;

      case 'prompt_only':
        result = await executePromptOnly(skill, ctx, logs);
        break;

      case 'node':
        result = await executeNode(skill, ctx, logs);
        break;

      case 'python':
        logs.push(`Runtime "python" is not yet implemented — cannot execute`);
        result = {
          success: false,
          outputs: { error: 'Python sandbox runtime not yet implemented. Use prompt_only runtime instead.' },
          logs,
          durationMs: Date.now() - start,
          runtime: 'python',
          error: 'Python sandbox runtime not yet implemented. Use prompt_only runtime instead.',
        };
        break;

      case 'wasm':
        logs.push(`Runtime "wasm" is not yet implemented — cannot execute`);
        result = {
          success: false,
          outputs: { error: 'WASM runtime not yet implemented. Use prompt_only runtime instead.' },
          logs,
          durationMs: Date.now() - start,
          runtime: 'wasm',
          error: 'WASM runtime not yet implemented. Use prompt_only runtime instead.',
        };
        break;

      default:
        result = {
          success: false,
          outputs: {},
          logs: [...logs, `Unknown runtime: ${skill.runtime}`],
          durationMs: Date.now() - start,
          runtime: skill.runtime,
          error: `Unknown runtime: ${skill.runtime}`,
        };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logs.push(`Execution failed: ${error}`);
    result = {
      success: false,
      outputs: {},
      logs,
      durationMs: Date.now() - start,
      runtime: skill.runtime,
      error,
    };
  }

  result.durationMs = Date.now() - start;

  broadcast('meow:skills', {
    type: 'skill_exec_complete',
    skill: skillName,
    moleculeId: ctx.moleculeId,
    stepId: ctx.stepId,
    success: result.success,
    durationMs: result.durationMs,
  });

  log.info({
    skill: skillName,
    runtime: skill.runtime,
    success: result.success,
    durationMs: result.durationMs,
    moleculeId: ctx.moleculeId,
    stepId: ctx.stepId,
  }, `Skill execution ${result.success ? 'completed' : 'failed'}`);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Builtin Runtime
// ─────────────────────────────────────────────────────────────────────────────

async function executeBuiltin(
  skill: SkillManifest,
  ctx: SkillExecContext,
  logs: string[],
): Promise<SkillExecResult> {
  const handler = builtins.get(skill.name);
  if (!handler) {
    logs.push(`No builtin handler for "${skill.name}" — trying generic handler`);
    // If skill name matches a registered builtin prefix, try partial match
    for (const [name, h] of builtins) {
      if (skill.name.startsWith(name) || skill.name.endsWith(name)) {
        logs.push(`Using partial match builtin: ${name}`);
        const outputs = await h(ctx);
        return { success: true, outputs, logs, durationMs: 0, runtime: 'builtin' };
      }
    }
    return {
      success: false,
      outputs: {},
      logs: [...logs, `No builtin handler found for "${skill.name}"`],
      durationMs: 0,
      runtime: 'builtin',
      error: `No builtin handler: ${skill.name}`,
    };
  }

  logs.push(`Running builtin handler: ${skill.name}`);
  const outputs = await handler(ctx);
  logs.push(`Builtin handler completed`);

  return { success: true, outputs, logs, durationMs: 0, runtime: 'builtin' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt-Only Runtime (LLM)
// ─────────────────────────────────────────────────────────────────────────────

async function executePromptOnly(
  skill: SkillManifest,
  ctx: SkillExecContext,
  logs: string[],
): Promise<SkillExecResult> {
  // Build system prompt from skill manifest
  const toolsDesc = skill.tools.provided.length > 0
    ? `\nAvailable tools:\n${skill.tools.provided.map(t => `- ${t.name}: ${t.description}`).join('\n')}`
    : '';

  const outputSpec = Object.keys(skill.outputs).length > 0
    ? `\nExpected outputs:\n${Object.entries(skill.outputs).map(([k, v]) => `- ${k} (${v.type}): ${v.description}`).join('\n')}`
    : '';

  const systemPrompt = [
    `You are executing the skill "${skill.name}".`,
    skill.description,
    toolsDesc,
    outputSpec,
    `\nRespond with a JSON object containing the output fields.`,
    `If you cannot produce valid JSON, wrap your response in a "result" field.`,
  ].filter(Boolean).join('\n');

  // Build user message from inputs
  const inputLines = Object.entries(ctx.inputs)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');

  const varsLine = ctx.vars && Object.keys(ctx.vars).length > 0
    ? `\nContext variables:\n${Object.entries(ctx.vars).map(([k, v]) => `${k}: ${v}`).join('\n')}`
    : '';

  const userMessage = [
    `Step: ${ctx.stepName} (molecule: ${ctx.moleculeId})`,
    inputLines ? `\nInputs:\n${inputLines}` : '',
    varsLine,
  ].filter(Boolean).join('\n');

  logs.push(`Calling LLM (prompt_only runtime)`);

  const model = ctx.tier === 'S' ? 'gemini-2.0-flash' : 'gemini-2.0-flash-lite';
  const response = await callLLM(systemPrompt, userMessage, model);

  logs.push(`LLM responded (${response.length} chars)`);

  // Detect LLM failures (simulated/error responses from callLLM)
  const llmFailed = /^\[LLM (unavailable|error|exception)/.test(response);
  if (llmFailed) {
    logs.push(`LLM call failed — response is simulated: ${response.slice(0, 120)}`);
    return {
      success: false,
      outputs: { error: response },
      logs,
      durationMs: 0,
      runtime: 'prompt_only',
      error: response,
    };
  }

  // Try to parse JSON from response
  let outputs: Record<string, unknown>;
  try {
    // Try extracting JSON from markdown code block
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
    outputs = JSON.parse(jsonMatch[1] || response);
  } catch {
    outputs = { result: response };
  }

  return { success: true, outputs, logs, durationMs: 0, runtime: 'prompt_only' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Node Runtime (sandboxed eval)
// ─────────────────────────────────────────────────────────────────────────────

async function executeNode(
  skill: SkillManifest,
  ctx: SkillExecContext,
  logs: string[],
): Promise<SkillExecResult> {
  if (!skill.entry) {
    logs.push('Node runtime requires entry field in manifest');
    return {
      success: false,
      outputs: {},
      logs,
      durationMs: 0,
      runtime: 'node',
      error: 'No entry point specified',
    };
  }

  logs.push(`Node runtime: entry=${skill.entry} (execution via dynamic import)`);

  // Node sandbox is not yet implemented — return explicit failure
  logs.push('Node runtime: sandbox not yet implemented — returning failure');

  return {
    success: false,
    outputs: { error: 'Node.js sandbox runtime not yet implemented. Use prompt_only runtime instead.' },
    logs,
    durationMs: 0,
    runtime: 'node',
    error: 'Node.js sandbox runtime not yet implemented. Use prompt_only runtime instead.',
  };
}

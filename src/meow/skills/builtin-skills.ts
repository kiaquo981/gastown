/**
 * Built-in Skills Library — EP-105
 *
 * 10 starter skills that ship with MEOW.
 * Each defined as a TOML string and registered on startup.
 */

import { registerSkillFromTOML } from '../skill-registry';
import { registerBuiltin } from '../skill-runtime';
import { createLogger } from '../../lib/logger';

const log = createLogger('builtin-skills');

// ─────────────────────────────────────────────────────────────────────────────
// SSRF Protection
// ─────────────────────────────────────────────────────────────────────────────

/** Block requests to internal/metadata/private IPs */
function validateUrl(urlStr: string): { valid: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { valid: false, error: 'Invalid URL' };
  }

  // Only allow http and https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, error: `Protocol "${parsed.protocol}" not allowed. Use http or https.` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
    return { valid: false, error: 'Requests to localhost/loopback are blocked' };
  }

  // Block cloud metadata endpoints
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    return { valid: false, error: 'Requests to cloud metadata endpoints are blocked' };
  }

  // Block private IP ranges
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every(n => !isNaN(n))) {
    if (parts[0] === 10) return { valid: false, error: 'Requests to private IPs (10.x.x.x) are blocked' };
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return { valid: false, error: 'Requests to private IPs (172.16-31.x.x) are blocked' };
    if (parts[0] === 192 && parts[1] === 168) return { valid: false, error: 'Requests to private IPs (192.168.x.x) are blocked' };
    if (parts[0] === 169 && parts[1] === 254) return { valid: false, error: 'Requests to link-local IPs (169.254.x.x) are blocked' };
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill TOML Definitions
// ─────────────────────────────────────────────────────────────────────────────

const SKILL_TOMLS: string[] = [

  // 1. Research — LLM-powered research on a topic
  `
[skill]
name = "research"
version = "1.0.0"
description = "Research a topic and produce a structured summary with key findings"
author = "meow"
runtime = "prompt_only"

[inputs.topic]
type = "string"
required = true
description = "The topic to research"

[inputs.depth]
type = "string"
required = false
description = "Research depth: shallow, medium, deep"

[outputs.summary]
type = "string"
description = "Structured research summary"

[outputs.findings]
type = "array"
description = "Key findings as bullet points"

[requirements]
capabilities = ["llm_call"]
`,

  // 2. Summarize — Condense text into key points
  `
[skill]
name = "summarize"
version = "1.0.0"
description = "Summarize text content into concise key points"
author = "meow"
runtime = "prompt_only"

[inputs.content]
type = "string"
required = true
description = "Text content to summarize"

[inputs.max_points]
type = "number"
required = false
description = "Maximum number of key points"

[outputs.summary]
type = "string"
description = "Concise summary"

[outputs.key_points]
type = "array"
description = "List of key points"

[requirements]
capabilities = ["llm_call"]
`,

  // 3. Code Review — Analyze code for quality issues
  `
[skill]
name = "code-review"
version = "1.0.0"
description = "Review code for quality, security, and best practices"
author = "meow"
runtime = "prompt_only"

[inputs.code]
type = "string"
required = true
description = "Code to review"

[inputs.language]
type = "string"
required = false
description = "Programming language"

[inputs.focus]
type = "string"
required = false
description = "Review focus: security, performance, readability, all"

[outputs.issues]
type = "array"
description = "List of issues found"

[outputs.score]
type = "number"
description = "Quality score 0-100"

[outputs.suggestions]
type = "array"
description = "Improvement suggestions"

[requirements]
capabilities = ["llm_call"]
minTier = "A"
`,

  // 4. Copy Write — Generate marketing copy
  `
[skill]
name = "copywrite"
version = "1.0.0"
description = "Generate marketing copy using proven frameworks (Halbert, Schwartz)"
author = "meow"
runtime = "prompt_only"

[inputs.product]
type = "string"
required = true
description = "Product or service to write copy for"

[inputs.audience]
type = "string"
required = true
description = "Target audience"

[inputs.framework]
type = "string"
required = false
description = "Copywriting framework: halbert, schwartz, hormozi, pas, aida"

[inputs.type]
type = "string"
required = false
description = "Copy type: headline, email, landing-page, ad, vsl"

[outputs.copy]
type = "string"
description = "Generated marketing copy"

[outputs.hooks]
type = "array"
description = "Alternative hook variations"

[requirements]
capabilities = ["llm_call"]
minTier = "A"
`,

  // 5. Data Transform — Process and transform data
  `
[skill]
name = "data-transform"
version = "1.0.0"
description = "Transform, filter, or aggregate data structures"
author = "meow"
runtime = "builtin"

[inputs.data]
type = "object"
required = true
description = "Data to transform"

[inputs.operation]
type = "string"
required = true
description = "Operation: filter, map, reduce, sort, group"

[inputs.spec]
type = "string"
required = false
description = "Transform specification or expression"

[outputs.result]
type = "object"
description = "Transformed data"

[outputs.count]
type = "number"
description = "Number of records in result"

[requirements]
capabilities = []
`,

  // 6. HTTP Request — Make an HTTP call
  `
[skill]
name = "http-request"
version = "1.0.0"
description = "Make an HTTP request to an external API"
author = "meow"
runtime = "builtin"

[inputs.url]
type = "string"
required = true
description = "URL to request"

[inputs.method]
type = "string"
required = false
description = "HTTP method: GET, POST, PUT, DELETE"

[inputs.headers]
type = "object"
required = false
description = "Request headers"

[inputs.body]
type = "object"
required = false
description = "Request body (for POST/PUT)"

[outputs.status]
type = "number"
description = "HTTP status code"

[outputs.body]
type = "object"
description = "Response body"

[requirements]
capabilities = ["http"]
`,

  // 7. Notify — Send notification via broadcast
  `
[skill]
name = "notify"
version = "1.0.0"
description = "Send a notification via SSE broadcast or webhook"
author = "meow"
runtime = "builtin"

[inputs.message]
type = "string"
required = true
description = "Notification message"

[inputs.channel]
type = "string"
required = false
description = "Notification channel: sse, webhook"

[inputs.severity]
type = "string"
required = false
description = "Severity: info, warning, error, critical"

[outputs.sent]
type = "boolean"
description = "Whether notification was sent"

[requirements]
capabilities = []
`,

  // 8. Gate Check — Validate conditions before proceeding
  `
[skill]
name = "gate-check"
version = "1.0.0"
description = "Validate conditions and decide pass/fail for a gate"
author = "meow"
runtime = "builtin"

[inputs.conditions]
type = "array"
required = true
description = "Array of condition objects with field, operator, value"

[inputs.data]
type = "object"
required = true
description = "Data to check conditions against"

[outputs.pass]
type = "boolean"
description = "Whether all conditions passed"

[outputs.results]
type = "array"
description = "Per-condition results"

[requirements]
capabilities = []
`,

  // 9. Plan — Generate an execution plan from a goal
  `
[skill]
name = "plan"
version = "1.0.0"
description = "Generate a step-by-step execution plan from a high-level goal"
author = "meow"
runtime = "prompt_only"

[inputs.goal]
type = "string"
required = true
description = "High-level goal or objective"

[inputs.constraints]
type = "string"
required = false
description = "Constraints or limitations"

[inputs.context]
type = "string"
required = false
description = "Additional context about the project"

[outputs.steps]
type = "array"
description = "Ordered list of execution steps"

[outputs.dependencies]
type = "object"
description = "Step dependency graph"

[outputs.estimate]
type = "string"
description = "Effort estimate"

[requirements]
capabilities = ["llm_call"]
minTier = "A"
`,

  // 10. Merge — Combine outputs from parallel steps
  `
[skill]
name = "merge"
version = "1.0.0"
description = "Merge and reconcile outputs from multiple parallel steps"
author = "meow"
runtime = "builtin"

[inputs.sources]
type = "array"
required = true
description = "Array of source outputs to merge"

[inputs.strategy]
type = "string"
required = false
description = "Merge strategy: concat, deep-merge, latest-wins"

[outputs.merged]
type = "object"
description = "Merged result"

[outputs.conflicts]
type = "array"
description = "Merge conflicts if any"

[requirements]
capabilities = []
`,
];

// ─────────────────────────────────────────────────────────────────────────────
// Builtin Handlers for non-LLM skills
// ─────────────────────────────────────────────────────────────────────────────

function registerBuiltinHandlers(): void {
  // data-transform
  registerBuiltin('data-transform', async (ctx) => {
    const data = ctx.inputs.data;
    const operation = String(ctx.inputs.operation || 'passthrough');

    if (operation === 'passthrough' || !data) {
      return { result: data, count: Array.isArray(data) ? data.length : 1 };
    }

    // For arrays
    if (Array.isArray(data)) {
      switch (operation) {
        case 'sort':
          return { result: [...data].sort(), count: data.length };
        case 'reverse':
          return { result: [...data].reverse(), count: data.length };
        case 'unique':
          return { result: [...new Set(data)], count: new Set(data).size };
        case 'count':
          return { result: data.length, count: data.length };
        default:
          return { result: data, count: data.length };
      }
    }

    return { result: data, count: 1 };
  });

  // http-request
  registerBuiltin('http-request', async (ctx) => {
    const url = String(ctx.inputs.url || '');
    const method = String(ctx.inputs.method || 'GET').toUpperCase();
    const headers = (ctx.inputs.headers || {}) as Record<string, string>;
    const body = ctx.inputs.body;

    if (!url) return { status: 400, body: { error: 'url is required' } };

    // SSRF protection: block internal, metadata, and private IPs
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      return { status: 403, body: { error: urlValidation.error } };
    }

    try {
      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
      });

      let respBody: unknown;
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('json')) {
        respBody = await resp.json();
      } else {
        respBody = await resp.text();
      }

      return { status: resp.status, body: respBody };
    } catch (err) {
      return { status: 0, body: { error: String(err) } };
    }
  });

  // notify
  registerBuiltin('notify', async (ctx) => {
    const message = String(ctx.inputs.message || '');
    const severity = String(ctx.inputs.severity || 'info');
    const { broadcast: bc } = await import('../../sse');

    bc('meow:notification', {
      type: 'skill_notification',
      message,
      severity,
      moleculeId: ctx.moleculeId,
      stepId: ctx.stepId,
      timestamp: new Date().toISOString(),
    });

    return { sent: true };
  });

  // gate-check
  registerBuiltin('gate-check', async (ctx) => {
    const conditions = (ctx.inputs.conditions || []) as Array<{ field: string; operator: string; value: unknown }>;
    const data = (ctx.inputs.data || {}) as Record<string, unknown>;
    const results: Array<{ field: string; pass: boolean; actual: unknown; expected: unknown }> = [];

    for (const cond of conditions) {
      const actual = data[cond.field];
      let pass = false;

      switch (cond.operator) {
        case 'eq': case '==': pass = actual === cond.value; break;
        case 'neq': case '!=': pass = actual !== cond.value; break;
        case 'gt': case '>': pass = Number(actual) > Number(cond.value); break;
        case 'gte': case '>=': pass = Number(actual) >= Number(cond.value); break;
        case 'lt': case '<': pass = Number(actual) < Number(cond.value); break;
        case 'lte': case '<=': pass = Number(actual) <= Number(cond.value); break;
        case 'exists': pass = actual !== undefined && actual !== null; break;
        case 'contains': pass = String(actual).includes(String(cond.value)); break;
        default: pass = actual === cond.value;
      }

      results.push({ field: cond.field, pass, actual, expected: cond.value });
    }

    return {
      pass: results.every(r => r.pass),
      results,
    };
  });

  // merge
  registerBuiltin('merge', async (ctx) => {
    const sources = (ctx.inputs.sources || []) as unknown[];
    const strategy = String(ctx.inputs.strategy || 'deep-merge');

    if (sources.length === 0) return { merged: {}, conflicts: [] };

    if (strategy === 'concat' && sources.every(Array.isArray)) {
      return { merged: sources.flat(), conflicts: [] };
    }

    // Deep merge objects
    const merged: Record<string, unknown> = {};
    const conflicts: Array<{ key: string; values: unknown[] }> = [];

    for (const source of sources) {
      if (typeof source === 'object' && source !== null && !Array.isArray(source)) {
        for (const [k, v] of Object.entries(source)) {
          if (k in merged && merged[k] !== v) {
            if (strategy === 'latest-wins') {
              merged[k] = v;
            } else {
              conflicts.push({ key: k, values: [merged[k], v] });
              merged[k] = v; // still take latest but report conflict
            }
          } else {
            merged[k] = v;
          }
        }
      }
    }

    return { merged, conflicts };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader — call on startup
// ─────────────────────────────────────────────────────────────────────────────

export function loadBuiltinSkills(): number {
  registerBuiltinHandlers();

  let loaded = 0;
  for (const toml of SKILL_TOMLS) {
    try {
      registerSkillFromTOML(toml);
      loaded++;
    } catch (err) {
      log.error({ err, toml: toml.slice(0, 80) }, 'Failed to load builtin skill');
    }
  }

  log.info({ loaded, total: SKILL_TOMLS.length }, 'Builtin skills loaded');
  return loaded;
}

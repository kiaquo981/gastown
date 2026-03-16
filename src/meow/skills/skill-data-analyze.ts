/**
 * Skill: Data Analysis — LP-017 (Stage 04 Wave 3)
 *
 * Real data analysis from Supabase/Postgres.
 * Actions: query, aggregate, report, chart_data
 *
 * Uses getPool() for DB access. Read-only parameterized queries.
 */

import { registerBuiltin } from '../skill-runtime';
import { registerSkillFromTOML } from '../skill-registry';
import { createLogger } from '../../lib/logger';

const log = createLogger('skill-data-analyze');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getDbPool() {
  try {
    const { getPool } = await import('../../db/client');
    return getPool();
  } catch {
    return null;
  }
}

/** Security: block dangerous SQL statements */
function validateReadOnly(sql: string): { valid: boolean; error?: string } {
  // Step 1: Strip SQL comments to prevent bypass via /* DROP TABLE */
  let cleaned = sql.replace(/\/\*[\s\S]*?\*\//g, ' '); // block comments
  cleaned = cleaned.replace(/--[^\n]*/g, ' ');           // line comments
  const normalized = cleaned.trim().toUpperCase();

  // Step 2: Check forbidden keywords ANYWHERE in the cleaned SQL (word-boundary match)
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'GRANT', 'REVOKE', 'EXECUTE'];
  for (const keyword of forbidden) {
    const regex = new RegExp(`\\b${keyword}\\b`);
    if (regex.test(normalized)) {
      return { valid: false, error: `Forbidden SQL operation: ${keyword}. Only SELECT and WITH (CTE) queries are allowed.` };
    }
  }

  // Step 3: Must start with SELECT, WITH, or EXPLAIN
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH') && !normalized.startsWith('EXPLAIN')) {
    return { valid: false, error: 'Only SELECT, WITH (CTE), and EXPLAIN queries are allowed.' };
  }
  return { valid: true };
}

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

async function queryDb(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sql = String(inputs.sql || inputs.query || '');
  const params = (inputs.params || []) as unknown[];
  const limit = Number(inputs.limit || 1000);

  if (!sql) return { success: false, error: 'sql is required' };

  const validation = validateReadOnly(sql);
  if (!validation.valid) return { success: false, error: validation.error };

  const pool = await getDbPool();
  if (!pool) {
    return { success: false, error: 'Database not available (DATABASE_URL not configured)' };
  }

  try {
    // Enforce LIMIT if not already present
    let safeSql = sql.trim();
    if (!safeSql.toUpperCase().includes('LIMIT') && !safeSql.toUpperCase().startsWith('EXPLAIN')) {
      safeSql = `${safeSql} LIMIT ${limit}`;
    }

    const result = await pool.query(safeSql, params);
    return {
      success: true,
      rows: result.rows,
      row_count: result.rowCount || result.rows.length,
      fields: result.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message, sql: sql.slice(0, 100) }, 'Query failed');
    return { success: false, error: `Query failed: ${message}` };
  }
}

async function aggregateData(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Can operate on raw data array or execute a query first
  let data: Array<Record<string, unknown>>;

  if (inputs.sql || inputs.query) {
    const queryResult = await queryDb(inputs);
    if (!queryResult.success) return queryResult;
    data = queryResult.rows as Array<Record<string, unknown>>;
  } else if (Array.isArray(inputs.data)) {
    data = inputs.data as Array<Record<string, unknown>>;
  } else {
    return { success: false, error: 'Provide "sql" or "data" array to aggregate' };
  }

  const field = String(inputs.field || inputs.column || '');
  const operations = (inputs.operations || ['count', 'sum', 'avg']) as string[];

  if (!field && operations.some(op => op !== 'count')) {
    return { success: false, error: 'field is required for operations other than count' };
  }

  const values = field ? data.map(r => Number(r[field])).filter(n => !isNaN(n)) : [];
  const sorted = [...values].sort((a, b) => a - b);
  const metrics: Record<string, number | null> = {};

  for (const op of operations) {
    switch (op) {
      case 'count':
        metrics.count = data.length;
        break;
      case 'sum':
        metrics.sum = values.reduce((a, b) => a + b, 0);
        break;
      case 'avg':
        metrics.avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
        break;
      case 'min':
        metrics.min = sorted.length > 0 ? sorted[0] : null;
        break;
      case 'max':
        metrics.max = sorted.length > 0 ? sorted[sorted.length - 1] : null;
        break;
      case 'median':
        metrics.median = sorted.length > 0 ? computePercentile(sorted, 50) : null;
        break;
      case 'p25':
        metrics.p25 = sorted.length > 0 ? computePercentile(sorted, 25) : null;
        break;
      case 'p75':
        metrics.p75 = sorted.length > 0 ? computePercentile(sorted, 75) : null;
        break;
      case 'p90':
        metrics.p90 = sorted.length > 0 ? computePercentile(sorted, 90) : null;
        break;
      case 'p95':
        metrics.p95 = sorted.length > 0 ? computePercentile(sorted, 95) : null;
        break;
      case 'stddev': {
        if (values.length > 1) {
          const avg = values.reduce((a, b) => a + b, 0) / values.length;
          const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1);
          metrics.stddev = Math.sqrt(variance);
        } else {
          metrics.stddev = null;
        }
        break;
      }
    }
  }

  return {
    success: true,
    field,
    sample_size: data.length,
    value_count: values.length,
    metrics,
  };
}

async function generateReport(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const title = String(inputs.title || 'Data Report');
  const description = String(inputs.description || '');

  // First aggregate the data
  const aggResult = await aggregateData(inputs);
  if (!aggResult.success) return aggResult;

  const metrics = aggResult.metrics as Record<string, number | null>;
  const sampleSize = aggResult.sample_size as number;
  const field = aggResult.field as string;

  // Build markdown report
  const lines: string[] = [
    `# ${title}`,
    '',
    description ? `${description}\n` : '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Sample Size:** ${sampleSize} records`,
    field ? `**Field Analyzed:** ${field}` : '',
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '|--------|-------|',
  ];

  for (const [key, value] of Object.entries(metrics)) {
    if (value !== null && value !== undefined) {
      const formatted = typeof value === 'number' ? value.toFixed(2) : String(value);
      lines.push(`| ${key} | ${formatted} |`);
    }
  }

  lines.push('', '---', `*Report generated by MEOW data-analyze skill*`);

  return {
    success: true,
    report: lines.join('\n'),
    title,
    metrics,
    sample_size: sampleSize,
  };
}

async function formatChartData(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  let data: Array<Record<string, unknown>>;

  if (inputs.sql || inputs.query) {
    const queryResult = await queryDb(inputs);
    if (!queryResult.success) return queryResult;
    data = queryResult.rows as Array<Record<string, unknown>>;
  } else if (Array.isArray(inputs.data)) {
    data = inputs.data as Array<Record<string, unknown>>;
  } else {
    return { success: false, error: 'Provide "sql" or "data" array' };
  }

  const xField = String(inputs.x_field || inputs.label_field || '');
  const yFields = (inputs.y_fields || inputs.value_fields || []) as string[];
  const chartType = String(inputs.chart_type || 'bar');

  if (!xField || yFields.length === 0) {
    // Auto-detect: first column = x, rest = y
    if (data.length > 0) {
      const keys = Object.keys(data[0]);
      const autoX = keys[0] || 'x';
      const autoY = keys.slice(1);
      return formatWithFields(data, autoX, autoY, chartType);
    }
    return { success: false, error: 'x_field and y_fields are required, or data must have detectable columns' };
  }

  return formatWithFields(data, xField, yFields, chartType);
}

function formatWithFields(
  data: Array<Record<string, unknown>>,
  xField: string,
  yFields: string[],
  chartType: string,
): Record<string, unknown> {
  const labels = data.map(r => String(r[xField] || ''));
  const datasets = yFields.map(field => ({
    label: field,
    data: data.map(r => Number(r[field] || 0)),
  }));

  return {
    success: true,
    chart_type: chartType,
    labels,
    datasets,
    data_points: data.length,
    x_field: xField,
    y_fields: yFields,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerDataAnalyzeSkill(): void {
  registerSkillFromTOML(`
[skill]
name = "data-analyze"
version = "1.0.0"
description = "Analyze data from Supabase: query, aggregate, report, chart"
author = "meow"
runtime = "builtin"

[inputs.action]
type = "string"
required = true
description = "Action: query, aggregate, report, chart_data"

[inputs.sql]
type = "string"
required = false
description = "SQL query (read-only, parameterized)"

[inputs.field]
type = "string"
required = false
description = "Field to analyze for aggregation"

[inputs.operations]
type = "array"
required = false
description = "Aggregation operations: count, sum, avg, min, max, median, p25, p75, p90, p95, stddev"

[inputs.data]
type = "array"
required = false
description = "Data array (alternative to SQL query)"

[outputs.success]
type = "boolean"
description = "Whether the operation succeeded"

[outputs.rows]
type = "array"
description = "Query result rows"

[outputs.metrics]
type = "object"
description = "Aggregated metrics"

[outputs.report]
type = "string"
description = "Markdown report"

[requirements]
capabilities = ["DbQuery"]
minTier = "B"
`);

  registerBuiltin('data-analyze', async (ctx) => {
    const action = String(ctx.inputs.action || 'query');
    log.info({ action, moleculeId: ctx.moleculeId }, 'Data analyze skill executing');

    switch (action) {
      case 'query':
        return queryDb(ctx.inputs);
      case 'aggregate':
        return aggregateData(ctx.inputs);
      case 'report':
        return generateReport(ctx.inputs);
      case 'chart_data':
        return formatChartData(ctx.inputs);
      default:
        return { success: false, error: `Unknown action: ${action}. Valid: query, aggregate, report, chart_data` };
    }
  });

  log.info('Data analyze skill registered');
}

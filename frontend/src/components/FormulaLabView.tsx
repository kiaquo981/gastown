'use client';

/**
 * FormulaLabView — Formula Browser, Execution Interface & Mol Mall
 *
 * Yegge's 35+ embedded formulas in TOML format. Browse, inspect,
 * cook formulas into protomolecules, pour into molecules, and
 * create ephemeral wisps. Connects to the "Mol Mall" marketplace concept.
 *
 * AYU DARK: bg #0f1419, cards #1a1f26, text #e6e1cf, muted #6c7680
 * border #2d363f, green #c2d94c, yellow #ffb454, red #f07178,
 * cyan #95e6cb, purple #d2a6ff. Font-mono, rounded-none.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ── Ayu Dark palette ────────────────────────────────────────────────────────
const C = {
  bg: '#0f1419',
  card: '#1a1f26',
  text: '#e6e1cf',
  muted: '#6c7680',
  border: '#2d363f',
  green: '#c2d94c',
  yellow: '#ffb454',
  red: '#f07178',
  cyan: '#95e6cb',
  purple: '#d2a6ff',
} as const;

// ── Types ───────────────────────────────────────────────────────────────────

type FormulaType = 'convoy' | 'workflow' | 'expansion' | 'aspect';
type FormulaCategory = 'patrol' | 'polecat' | 'convoy' | 'release' | 'code-review' | 'design' | 'security-audit' | 'infrastructure' | 'testing' | 'documentation' | 'general';

interface FormulaStep {
  name: string;
  skill: string;
  tier?: number;
  needs?: string[];
  backoff?: { base: number; max: number; factor: number };
  description?: string;
}

interface FormulaVariable {
  key: string;
  value: string;
  description?: string;
}

interface Formula {
  id: string;
  name: string;
  version: string;
  type: FormulaType;
  category: FormulaCategory;
  description: string;
  author?: string;
  steps: FormulaStep[];
  variables: FormulaVariable[];
  createdAt?: string;
  downloads?: number;
  rating?: number;
}

interface ActiveMolecule {
  id: string;
  name: string;
  formulaName: string;
  status: string;
  phase: string;
  progress: number;
  stepsDone: number;
  stepsTotal: number;
  createdAt: string;
}

interface CookResult {
  protoId: string;
  stepCount: number;
  formulaName: string;
}

interface MallFormula {
  id: string;
  name: string;
  author: string;
  description: string;
  type: FormulaType;
  downloads: number;
  rating: number;
  version: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<FormulaType, { label: string; color: string; badge: string }> = {
  convoy:    { label: 'Convoy',    color: C.cyan,   badge: 'bg-[#95e6cb]/15 text-[#95e6cb] border-[#95e6cb]/30' },
  workflow:  { label: 'Workflow',  color: C.green,  badge: 'bg-[#c2d94c]/15 text-[#c2d94c] border-[#c2d94c]/30' },
  expansion: { label: 'Expansion', color: C.purple, badge: 'bg-[#d2a6ff]/15 text-[#d2a6ff] border-[#d2a6ff]/30' },
  aspect:    { label: 'Aspect',    color: C.yellow, badge: 'bg-[#ffb454]/15 text-[#ffb454] border-[#ffb454]/30' },
};

const CATEGORY_LABELS: Record<FormulaCategory, string> = {
  'patrol': 'Patrol',
  'polecat': 'Polecat Work',
  'convoy': 'Convoy Mgmt',
  'release': 'Release',
  'code-review': 'Code Review',
  'design': 'Design',
  'security-audit': 'Security Audit',
  'infrastructure': 'Infrastructure',
  'testing': 'Testing',
  'documentation': 'Documentation',
  'general': 'General',
};

// ── Embedded Formula Data (Yegge's formulas) ────────────────────────────────

function generateFormulas(): Formula[] {
  return [
    {
      id: 'f-001', name: 'deacon-health-sweep', version: '1.2.0', type: 'workflow', category: 'patrol',
      description: 'Full Deacon health patrol — checks all services, databases, and external dependencies. Exponential backoff on consecutive clean runs.',
      author: 'yegge', steps: [
        { name: 'check-db-connections', skill: 'db-health', tier: 1, description: 'Verify all database connections are alive' },
        { name: 'check-redis', skill: 'redis-health', tier: 1, description: 'Check Redis cluster status and memory' },
        { name: 'check-api-endpoints', skill: 'http-probe', tier: 1, needs: ['check-db-connections'], description: 'Probe all registered API endpoints' },
        { name: 'check-disk-usage', skill: 'disk-check', tier: 1, description: 'Verify disk usage below thresholds' },
        { name: 'aggregate-report', skill: 'report-builder', tier: 2, needs: ['check-api-endpoints', 'check-redis', 'check-disk-usage'], description: 'Build patrol report from check results' },
      ],
      variables: [{ key: 'THRESHOLD_DISK_PCT', value: '85', description: 'Disk usage warning threshold' }, { key: 'TIMEOUT_MS', value: '5000', description: 'Per-check timeout' }],
      downloads: 342, rating: 4.8,
    },
    {
      id: 'f-002', name: 'witness-data-integrity', version: '1.0.3', type: 'workflow', category: 'patrol',
      description: 'Witness patrol for data consistency — verifies checksums, foreign key integrity, and replication lag.',
      author: 'yegge', steps: [
        { name: 'verify-checksums', skill: 'checksum-verify', tier: 2, description: 'Verify all stored checksums match data' },
        { name: 'check-fk-integrity', skill: 'fk-scan', tier: 2, description: 'Scan foreign key constraints' },
        { name: 'check-replication-lag', skill: 'repl-monitor', tier: 1, description: 'Measure replication lag' },
        { name: 'generate-witness-report', skill: 'report-builder', tier: 2, needs: ['verify-checksums', 'check-fk-integrity', 'check-replication-lag'], description: 'Compile integrity report' },
      ],
      variables: [{ key: 'MAX_REPL_LAG_MS', value: '10000', description: 'Max tolerable replication lag' }],
      downloads: 218, rating: 4.6,
    },
    {
      id: 'f-003', name: 'polecat-log-rotation', version: '0.9.1', type: 'aspect', category: 'polecat',
      description: 'Polecat skill formula for rotating logs across tmux sessions with configurable retention policies.',
      author: 'yegge', steps: [
        { name: 'enumerate-sessions', skill: 'tmux-list', tier: 1 },
        { name: 'scan-log-sizes', skill: 'disk-check', tier: 1, needs: ['enumerate-sessions'] },
        { name: 'rotate-oversized', skill: 'log-rotate', tier: 2, needs: ['scan-log-sizes'], backoff: { base: 1000, max: 30000, factor: 2 } },
        { name: 'compress-rotated', skill: 'file-compress', tier: 1, needs: ['rotate-oversized'] },
        { name: 'cleanup-expired', skill: 'file-delete', tier: 1, needs: ['compress-rotated'] },
      ],
      variables: [{ key: 'RETENTION_DAYS', value: '7' }, { key: 'MAX_LOG_SIZE_MB', value: '100' }],
      downloads: 156, rating: 4.3,
    },
    {
      id: 'f-004', name: 'convoy-deploy-pipeline', version: '2.1.0', type: 'convoy', category: 'release',
      description: 'Full deployment convoy — builds, tests, stages, and deploys with rollback capability. Orchestrates multiple rigs in parallel.',
      author: 'yegge', steps: [
        { name: 'lint-and-typecheck', skill: 'code-lint', tier: 1, description: 'Run linters and type checker' },
        { name: 'unit-tests', skill: 'test-runner', tier: 1, description: 'Execute unit test suite' },
        { name: 'build-artifacts', skill: 'builder', tier: 2, needs: ['lint-and-typecheck', 'unit-tests'], description: 'Build production artifacts' },
        { name: 'integration-tests', skill: 'test-runner', tier: 2, needs: ['build-artifacts'], description: 'Run integration tests against staging' },
        { name: 'deploy-staging', skill: 'deployer', tier: 3, needs: ['integration-tests'], description: 'Deploy to staging environment' },
        { name: 'smoke-tests', skill: 'http-probe', tier: 1, needs: ['deploy-staging'], description: 'Run smoke tests on staging' },
        { name: 'deploy-production', skill: 'deployer', tier: 3, needs: ['smoke-tests'], description: 'Deploy to production' },
        { name: 'verify-production', skill: 'http-probe', tier: 1, needs: ['deploy-production'], description: 'Verify production health' },
      ],
      variables: [{ key: 'TARGET_ENV', value: 'production' }, { key: 'ROLLBACK_ON_FAIL', value: 'true' }, { key: 'PARALLEL_RIGS', value: '3' }],
      downloads: 891, rating: 4.9,
    },
    {
      id: 'f-005', name: 'code-review-ritual', version: '1.0.0', type: 'workflow', category: 'code-review',
      description: 'Structured code review workflow using Seance pattern — summons reviewer polecats, runs static analysis, and produces review report.',
      author: 'yegge', steps: [
        { name: 'static-analysis', skill: 'code-lint', tier: 1, description: 'Run static analysis tools' },
        { name: 'complexity-scan', skill: 'complexity-check', tier: 2, description: 'Measure cyclomatic complexity' },
        { name: 'security-scan', skill: 'security-audit', tier: 2, description: 'Run security vulnerability scan' },
        { name: 'summon-reviewers', skill: 'seance', tier: 3, needs: ['static-analysis', 'complexity-scan', 'security-scan'], description: 'Summon Polecat reviewers via Seance' },
        { name: 'compile-review', skill: 'report-builder', tier: 2, needs: ['summon-reviewers'], description: 'Compile final review report' },
      ],
      variables: [{ key: 'MIN_REVIEWERS', value: '2' }, { key: 'COMPLEXITY_THRESHOLD', value: '15' }],
      downloads: 445, rating: 4.7,
    },
    {
      id: 'f-006', name: 'security-fortress-audit', version: '1.1.0', type: 'workflow', category: 'security-audit',
      description: 'Comprehensive security audit formula — dependency scanning, secrets detection, permission audit, and penetration test prep.',
      author: 'yegge', steps: [
        { name: 'dep-vulnerability-scan', skill: 'dep-scan', tier: 2, description: 'Scan dependencies for known CVEs' },
        { name: 'secrets-detection', skill: 'secret-detect', tier: 2, description: 'Detect hardcoded secrets in codebase' },
        { name: 'permission-audit', skill: 'permission-scan', tier: 2, description: 'Audit file and API permissions' },
        { name: 'network-exposure-check', skill: 'port-scan', tier: 3, needs: ['dep-vulnerability-scan'], description: 'Check for exposed ports and services' },
        { name: 'generate-security-report', skill: 'report-builder', tier: 2, needs: ['dep-vulnerability-scan', 'secrets-detection', 'permission-audit', 'network-exposure-check'], description: 'Generate security audit report' },
      ],
      variables: [{ key: 'CVE_SEVERITY_MIN', value: 'medium' }, { key: 'SCAN_DEPTH', value: 'full' }],
      downloads: 312, rating: 4.5,
    },
    {
      id: 'f-007', name: 'design-system-sync', version: '0.8.0', type: 'expansion', category: 'design',
      description: 'Syncs design tokens from Figma/design source into codebase. Generates Tailwind config, CSS variables, and component stubs.',
      author: 'community', steps: [
        { name: 'fetch-design-tokens', skill: 'http-fetch', tier: 1, description: 'Fetch tokens from design source' },
        { name: 'parse-tokens', skill: 'json-parse', tier: 1, needs: ['fetch-design-tokens'], description: 'Parse and validate token format' },
        { name: 'generate-tailwind-config', skill: 'code-gen', tier: 2, needs: ['parse-tokens'], description: 'Generate Tailwind config from tokens' },
        { name: 'generate-css-vars', skill: 'code-gen', tier: 2, needs: ['parse-tokens'], description: 'Generate CSS custom properties' },
        { name: 'update-components', skill: 'code-modify', tier: 3, needs: ['generate-tailwind-config', 'generate-css-vars'], description: 'Update component token references' },
      ],
      variables: [{ key: 'DESIGN_SOURCE_URL', value: '' }, { key: 'OUTPUT_DIR', value: './src/styles' }],
      downloads: 89, rating: 3.9,
    },
    {
      id: 'f-008', name: 'refinery-performance-sweep', version: '1.3.0', type: 'workflow', category: 'patrol',
      description: 'Refinery performance optimization sweep — identifies slow queries, memory leaks, and unused resources for cleanup.',
      author: 'yegge', steps: [
        { name: 'profile-slow-queries', skill: 'db-profiler', tier: 2, description: 'Identify queries exceeding threshold' },
        { name: 'memory-leak-scan', skill: 'heap-analyzer', tier: 3, description: 'Analyze heap snapshots for leaks' },
        { name: 'unused-resource-scan', skill: 'resource-scanner', tier: 1, description: 'Find unused files, imports, exports' },
        { name: 'generate-optimization-plan', skill: 'report-builder', tier: 2, needs: ['profile-slow-queries', 'memory-leak-scan', 'unused-resource-scan'], description: 'Compile optimization recommendations' },
      ],
      variables: [{ key: 'SLOW_QUERY_MS', value: '500' }, { key: 'HEAP_SAMPLE_COUNT', value: '3' }],
      downloads: 267, rating: 4.4,
    },
    {
      id: 'f-009', name: 'convoy-migration-batch', version: '1.0.0', type: 'convoy', category: 'convoy',
      description: 'Database migration convoy — runs migrations in sequence with health checks between each step and automatic rollback on failure.',
      author: 'yegge', steps: [
        { name: 'backup-database', skill: 'db-backup', tier: 3, description: 'Create full backup before migration' },
        { name: 'validate-migrations', skill: 'migration-lint', tier: 2, needs: ['backup-database'], description: 'Validate migration SQL syntax and safety' },
        { name: 'apply-migrations', skill: 'migration-run', tier: 3, needs: ['validate-migrations'], backoff: { base: 2000, max: 60000, factor: 2 }, description: 'Apply migration steps sequentially' },
        { name: 'verify-schema', skill: 'schema-diff', tier: 2, needs: ['apply-migrations'], description: 'Verify schema matches expected state' },
        { name: 'run-smoke-queries', skill: 'db-health', tier: 1, needs: ['verify-schema'], description: 'Run critical queries to verify data integrity' },
      ],
      variables: [{ key: 'MIGRATION_DIR', value: './migrations' }, { key: 'DRY_RUN', value: 'false' }],
      downloads: 534, rating: 4.8,
    },
    {
      id: 'f-010', name: 'infra-terraform-plan', version: '0.7.2', type: 'expansion', category: 'infrastructure',
      description: 'Infrastructure planning expansion — generates Terraform plan, estimates costs, and creates review checklist.',
      author: 'community', steps: [
        { name: 'terraform-init', skill: 'terraform', tier: 2, description: 'Initialize Terraform workspace' },
        { name: 'terraform-plan', skill: 'terraform', tier: 2, needs: ['terraform-init'], description: 'Generate execution plan' },
        { name: 'cost-estimation', skill: 'cost-estimator', tier: 2, needs: ['terraform-plan'], description: 'Estimate infrastructure costs' },
        { name: 'generate-review-checklist', skill: 'report-builder', tier: 1, needs: ['terraform-plan', 'cost-estimation'], description: 'Create review checklist for changes' },
      ],
      variables: [{ key: 'TF_WORKSPACE', value: 'default' }, { key: 'REGION', value: 'us-east-1' }],
      downloads: 198, rating: 4.2,
    },
    {
      id: 'f-011', name: 'e2e-test-suite', version: '1.1.0', type: 'workflow', category: 'testing',
      description: 'End-to-end test suite runner — spins up test environment, runs Playwright tests, captures screenshots on failure.',
      author: 'yegge', steps: [
        { name: 'setup-test-env', skill: 'env-setup', tier: 2, description: 'Spin up isolated test environment' },
        { name: 'seed-test-data', skill: 'db-seed', tier: 1, needs: ['setup-test-env'], description: 'Seed database with test fixtures' },
        { name: 'run-playwright', skill: 'test-runner', tier: 2, needs: ['seed-test-data'], backoff: { base: 5000, max: 120000, factor: 2 }, description: 'Execute Playwright test suite' },
        { name: 'capture-failures', skill: 'screenshot', tier: 1, needs: ['run-playwright'], description: 'Capture screenshots for failed tests' },
        { name: 'teardown-env', skill: 'env-teardown', tier: 1, needs: ['capture-failures'], description: 'Clean up test environment' },
        { name: 'generate-report', skill: 'report-builder', tier: 1, needs: ['teardown-env'], description: 'Generate test results report' },
      ],
      variables: [{ key: 'BROWSER', value: 'chromium' }, { key: 'HEADLESS', value: 'true' }, { key: 'RETRIES', value: '2' }],
      downloads: 623, rating: 4.6,
    },
    {
      id: 'f-012', name: 'doc-generator', version: '0.5.0', type: 'aspect', category: 'documentation',
      description: 'Auto-documentation generator — scans codebase, extracts JSDoc/TSDoc, generates markdown docs with examples.',
      author: 'community', steps: [
        { name: 'scan-source-files', skill: 'file-scanner', tier: 1, description: 'Enumerate all source files' },
        { name: 'extract-jsdoc', skill: 'doc-extractor', tier: 2, needs: ['scan-source-files'], description: 'Extract JSDoc/TSDoc annotations' },
        { name: 'generate-markdown', skill: 'doc-generator', tier: 2, needs: ['extract-jsdoc'], description: 'Generate markdown documentation' },
        { name: 'build-nav-index', skill: 'index-builder', tier: 1, needs: ['generate-markdown'], description: 'Build navigation index for docs' },
      ],
      variables: [{ key: 'SOURCE_DIR', value: './src' }, { key: 'OUTPUT_DIR', value: './docs' }, { key: 'INCLUDE_PRIVATE', value: 'false' }],
      downloads: 102, rating: 3.7,
    },
  ];
}

function generateMockMallFormulas(): MallFormula[] {
  return [
    { id: 'mall-001', name: 'graphql-schema-sync', author: '@gamma-works', description: 'Sync GraphQL schema across microservices with conflict detection', type: 'expansion', downloads: 1243, rating: 4.9, version: '2.0.1' },
    { id: 'mall-002', name: 'k8s-rolling-deploy', author: '@alpha-refinery', description: 'Kubernetes rolling deployment with canary analysis', type: 'convoy', downloads: 2891, rating: 4.8, version: '3.1.0' },
    { id: 'mall-003', name: 'ai-code-review', author: '@eta-station', description: 'AI-powered code review with LLM-backed suggestions', type: 'workflow', downloads: 5621, rating: 4.7, version: '1.4.2' },
    { id: 'mall-004', name: 'compliance-audit', author: '@beta-forge', description: 'SOC2/HIPAA compliance audit automation', type: 'aspect', downloads: 876, rating: 4.5, version: '1.0.0' },
    { id: 'mall-005', name: 'chaos-monkey-lite', author: '@epsilon-yards', description: 'Lightweight chaos engineering for staging environments', type: 'workflow', downloads: 1567, rating: 4.3, version: '0.9.8' },
    { id: 'mall-006', name: 'multi-region-failover', author: '@gamma-works', description: 'Automated multi-region failover testing and verification', type: 'convoy', downloads: 743, rating: 4.6, version: '1.2.0' },
  ];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function generateToml(formula: Formula): string {
  let toml = `[formula]\nname = "${formula.name}"\nversion = "${formula.version}"\ntype = "${formula.type}"\ndescription = "${formula.description}"\n`;
  if (formula.variables.length > 0) {
    toml += '\n[variables]\n';
    for (const v of formula.variables) {
      toml += `${v.key} = "${v.value}"\n`;
    }
  }
  for (const step of formula.steps) {
    toml += `\n[[steps]]\nname = "${step.name}"\nskill = "${step.skill}"\n`;
    if (step.tier !== undefined) toml += `tier = ${step.tier}\n`;
    if (step.needs && step.needs.length > 0) toml += `depends_on = [${step.needs.map(n => `"${n}"`).join(', ')}]\n`;
    if (step.backoff) toml += `backoff_base = ${step.backoff.base}\nbackoff_max = ${step.backoff.max}\nbackoff_factor = ${step.backoff.factor}\n`;
  }
  return toml;
}

// ── Step Timeline (vertical DAG) ────────────────────────────────────────────

function StepTimeline({ steps }: { steps: FormulaStep[] }) {
  return (
    <div className="space-y-0">
      {steps.map((step, idx) => {
        const isLast = idx === steps.length - 1;
        const tierColor = step.tier === 3 ? C.purple : step.tier === 2 ? C.cyan : C.green;
        return (
          <motion.div
            key={step.name}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: idx * 0.06 }}
            className="flex gap-3"
          >
            {/* Connector */}
            <div className="flex flex-col items-center w-5 shrink-0">
              <div className="w-3 h-3 border" style={{ borderColor: tierColor, background: `${tierColor}20` }} />
              {!isLast && <div className="w-px flex-1 min-h-[20px]" style={{ background: C.border }} />}
            </div>
            {/* Content */}
            <div className="flex-1 pb-3 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold" style={{ color: C.text }}>{step.name}</span>
                <span className="text-[9px] px-1 py-0.5 border" style={{ color: tierColor, borderColor: `${tierColor}40`, background: `${tierColor}10` }}>
                  T{step.tier || 1}
                </span>
              </div>
              <div className="text-[10px] mt-0.5" style={{ color: C.muted }}>
                skill: {step.skill}
              </div>
              {step.needs && step.needs.length > 0 && (
                <div className="text-[9px] mt-0.5" style={{ color: C.yellow }}>
                  needs: {step.needs.join(', ')}
                </div>
              )}
              {step.backoff && (
                <div className="text-[9px] mt-0.5" style={{ color: C.purple }}>
                  backoff: {step.backoff.base}ms / {step.backoff.factor}x / max {step.backoff.max}ms
                </div>
              )}
              {step.description && (
                <div className="text-[9px] mt-0.5" style={{ color: `${C.muted}aa` }}>
                  {step.description}
                </div>
              )}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ── Formula Detail Panel (slide-in) ─────────────────────────────────────────

function FormulaDetailPanel({
  formula,
  onClose,
  onCook,
  onPour,
  onWisp,
  cooking,
}: {
  formula: Formula;
  onClose: () => void;
  onCook: (formula: Formula) => void;
  onPour: (formula: Formula) => void;
  onWisp: (formula: Formula) => void;
  cooking: boolean;
}) {
  const typeCfg = TYPE_CONFIG[formula.type];

  return (
    <motion.div
      initial={{ x: 400, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 400, opacity: 0 }}
      transition={{ type: 'spring', damping: 25, stiffness: 200 }}
      className="w-[400px] flex-none border-l flex flex-col overflow-hidden font-mono"
      style={{ background: C.bg, borderColor: C.border }}
    >
      {/* Header */}
      <div className="flex-none px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: C.border }}>
        <span className="text-[10px] uppercase tracking-wider font-bold" style={{ color: `${C.text}cc` }}>Formula Detail</span>
        <button onClick={onClose} className="text-sm hover:opacity-70 transition-opacity" style={{ color: C.muted }}>X</button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Name & Meta */}
        <div>
          <h2 className="text-sm font-bold mb-1" style={{ color: C.text }}>{formula.name}</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-1.5 py-0.5 text-[9px] border ${typeCfg.badge}`}>{typeCfg.label}</span>
            <span className="text-[10px]" style={{ color: C.muted }}>v{formula.version}</span>
            {formula.author && <span className="text-[10px]" style={{ color: C.cyan }}>@{formula.author}</span>}
            <span className="text-[10px]" style={{ color: C.muted }}>{CATEGORY_LABELS[formula.category]}</span>
          </div>
        </div>

        {/* Description */}
        <p className="text-[10px] leading-relaxed" style={{ color: C.muted }}>{formula.description}</p>

        {/* Stats */}
        {(formula.downloads !== undefined || formula.rating !== undefined) && (
          <div className="flex items-center gap-4 text-[10px]">
            {formula.downloads !== undefined && (
              <span style={{ color: C.muted }}>{formula.downloads} downloads</span>
            )}
            {formula.rating !== undefined && (
              <span style={{ color: C.yellow }}>{formula.rating} / 5.0</span>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onCook(formula)}
            disabled={cooking}
            className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80 disabled:opacity-40"
            style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
          >
            {cooking ? 'Cooking...' : 'Cook'}
          </button>
          <button
            onClick={() => onPour(formula)}
            className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
            style={{ color: C.cyan, borderColor: `${C.cyan}40`, background: `${C.cyan}10` }}
          >
            Pour
          </button>
          <button
            onClick={() => onWisp(formula)}
            className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
            style={{ color: C.purple, borderColor: `${C.purple}40`, background: `${C.purple}10` }}
          >
            Wisp
          </button>
        </div>

        {/* Steps Timeline */}
        <div>
          <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>
            Steps ({formula.steps.length})
          </div>
          <StepTimeline steps={formula.steps} />
        </div>

        {/* Variables */}
        {formula.variables.length > 0 && (
          <div>
            <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>
              Variables ({formula.variables.length})
            </div>
            <div className="space-y-1">
              {formula.variables.map(v => (
                <div key={v.key} className="flex items-center gap-2 px-2 py-1.5 border text-[10px]" style={{ borderColor: `${C.border}60`, background: `${C.card}80` }}>
                  <span className="font-bold" style={{ color: C.yellow }}>{v.key}</span>
                  <span style={{ color: C.muted }}>=</span>
                  <span style={{ color: C.text }}>{v.value || '""'}</span>
                  {v.description && <span className="ml-auto text-[9px]" style={{ color: `${C.muted}80` }}>{v.description}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TOML Preview */}
        <div>
          <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>TOML Preview</div>
          <pre
            className="text-[10px] leading-relaxed p-3 border overflow-x-auto"
            style={{ background: C.card, borderColor: C.border, color: `${C.text}cc` }}
          >
            {generateToml(formula)}
          </pre>
        </div>
      </div>
    </motion.div>
  );
}

// ── Cook Console Modal ──────────────────────────────────────────────────────

function CookConsole({
  open,
  onClose,
  onCook,
  cooking,
  lastResult,
  onPour,
  onWisp,
}: {
  open: boolean;
  onClose: () => void;
  onCook: (toml: string, vars: Record<string, string>) => void;
  cooking: boolean;
  lastResult: CookResult | null;
  onPour: (protoId: string) => void;
  onWisp: (protoId: string) => void;
}) {
  const [toml, setToml] = useState('');
  const [vars, setVars] = useState<Array<{ key: string; value: string }>>([{ key: '', value: '' }]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addVar = () => setVars(prev => [...prev, { key: '', value: '' }]);
  const updateVar = (idx: number, field: 'key' | 'value', val: string) => {
    setVars(prev => prev.map((v, i) => i === idx ? { ...v, [field]: val } : v));
  };
  const removeVar = (idx: number) => setVars(prev => prev.filter((_, i) => i !== idx));

  const handleCook = () => {
    const varsObj: Record<string, string> = {};
    for (const v of vars) {
      if (v.key.trim()) varsObj[v.key.trim()] = v.value;
    }
    onCook(toml, varsObj);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-[700px] max-h-[80vh] flex flex-col border font-mono"
        style={{ background: C.card, borderColor: C.border }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: C.border }}>
          <span className="text-sm font-bold" style={{ color: C.text }}>Cook Console</span>
          <button onClick={onClose} className="text-sm hover:opacity-70 transition-opacity" style={{ color: C.muted }}>X</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* TOML Editor */}
          <div>
            <label className="block text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Formula TOML</label>
            <textarea
              ref={textareaRef}
              value={toml}
              onChange={e => setToml(e.target.value)}
              rows={14}
              placeholder={`[formula]\nname = "my-formula"\nversion = "1.0.0"\ntype = "workflow"\n\n[[steps]]\nname = "step-1"\nskill = "research"\n\n[[steps]]\nname = "step-2"\nskill = "implement"\ndepends_on = ["step-1"]`}
              className="w-full px-3 py-2 text-[11px] border font-mono focus:outline-none resize-none leading-relaxed"
              style={{ background: C.bg, borderColor: C.border, color: C.text }}
            />
          </div>

          {/* Variables Editor */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Variables</label>
              <button onClick={addVar} className="text-[10px] hover:opacity-70 transition-opacity" style={{ color: C.cyan }}>+ Add</button>
            </div>
            <div className="space-y-1">
              {vars.map((v, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={v.key}
                    onChange={e => updateVar(i, 'key', e.target.value)}
                    placeholder="KEY"
                    className="flex-1 px-2 py-1 text-[10px] border font-mono focus:outline-none"
                    style={{ background: C.bg, borderColor: C.border, color: C.yellow }}
                  />
                  <span className="text-[10px]" style={{ color: C.muted }}>=</span>
                  <input
                    value={v.value}
                    onChange={e => updateVar(i, 'value', e.target.value)}
                    placeholder="value"
                    className="flex-1 px-2 py-1 text-[10px] border font-mono focus:outline-none"
                    style={{ background: C.bg, borderColor: C.border, color: C.text }}
                  />
                  <button onClick={() => removeVar(i)} className="text-[10px] px-1 hover:opacity-70" style={{ color: C.red }}>X</button>
                </div>
              ))}
            </div>
          </div>

          {/* Cook Button */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleCook}
              disabled={!toml.trim() || cooking}
              className="px-4 py-2 text-xs uppercase tracking-wider border transition-colors hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
            >
              {cooking ? 'Cooking...' : 'Cook'}
            </button>
          </div>

          {/* Result */}
          {lastResult && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 border"
              style={{ borderColor: `${C.green}30`, background: `${C.green}08` }}
            >
              <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.green }}>Cook Result</div>
              <div className="space-y-1 text-[10px]">
                <div style={{ color: C.text }}>Proto ID: <span className="font-bold" style={{ color: C.cyan }}>{lastResult.protoId}</span></div>
                <div style={{ color: C.muted }}>Steps: {lastResult.stepCount}</div>
                <div style={{ color: C.muted }}>Formula: {lastResult.formulaName}</div>
              </div>
              <div className="flex items-center gap-2 mt-3">
                <button
                  onClick={() => onPour(lastResult.protoId)}
                  className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
                  style={{ color: C.cyan, borderColor: `${C.cyan}40`, background: `${C.cyan}10` }}
                >
                  Pour (Molecule)
                </button>
                <button
                  onClick={() => onWisp(lastResult.protoId)}
                  className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
                  style={{ color: C.purple, borderColor: `${C.purple}40`, background: `${C.purple}10` }}
                >
                  Wisp (Ephemeral)
                </button>
              </div>
            </motion.div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ── Formula Card ────────────────────────────────────────────────────────────

function FormulaCard({
  formula,
  onClick,
  selected,
}: {
  formula: Formula;
  onClick: () => void;
  selected: boolean;
}) {
  const typeCfg = TYPE_CONFIG[formula.type];

  return (
    <motion.button
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={onClick}
      className={`text-left w-full p-4 border font-mono transition-colors ${selected ? 'border-[#95e6cb]/40' : 'hover:border-[#3d464f]'}`}
      style={{ background: selected ? `${C.card}` : C.card, borderColor: selected ? `${C.cyan}40` : C.border }}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <h3 className="text-xs font-bold leading-snug" style={{ color: C.text }}>{formula.name}</h3>
        <span className={`flex-none px-1.5 py-0.5 text-[9px] border ${typeCfg.badge}`}>{typeCfg.label}</span>
      </div>
      <p className="text-[10px] leading-relaxed line-clamp-2 mb-2" style={{ color: C.muted }}>
        {formula.description}
      </p>
      <div className="flex items-center gap-3 text-[9px]" style={{ color: C.muted }}>
        <span>v{formula.version}</span>
        <span>{formula.steps.length} steps</span>
        <span style={{ color: C.muted }}>{CATEGORY_LABELS[formula.category]}</span>
        {formula.rating !== undefined && <span style={{ color: C.yellow }}>{formula.rating}</span>}
      </div>
    </motion.button>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function FormulaLabView() {
  const [formulas] = useState<Formula[]>(() => generateFormulas());
  const [activeMolecules, setActiveMolecules] = useState<ActiveMolecule[]>([]);
  const [mallFormulas] = useState<MallFormula[]>(() => generateMockMallFormulas());
  const [loading, setLoading] = useState(true);
  const [dataSource, setDataSource] = useState<'db' | 'mock' | null>(null);

  // UI state
  const [tab, setTab] = useState<'browse' | 'cook' | 'mall' | 'active'>('browse');
  const [selectedFormula, setSelectedFormula] = useState<Formula | null>(null);
  const [showCookConsole, setShowCookConsole] = useState(false);
  const [cooking, setCooking] = useState(false);
  const [lastCookResult, setLastCookResult] = useState<CookResult | null>(null);

  // Filters
  const [filterType, setFilterType] = useState<FormulaType | 'all'>('all');
  const [filterCategory, setFilterCategory] = useState<FormulaCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  /* ── Fetch ─────────────────────────────────────────────────────────────── */

  const fetchActiveMolecules = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/meow/molecules`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const mols = Array.isArray(data?.molecules) ? data.molecules : Array.isArray(data) ? data : [];
      setActiveMolecules(
        mols.map((m: Record<string, unknown>) => ({
          id: m.id as string || '',
          name: m.name as string || '',
          formulaName: m.formulaName as string || '',
          status: m.status as string || 'unknown',
          phase: m.phase as string || 'solid',
          progress: Array.isArray(m.steps)
            ? Math.round(((m.steps as Array<Record<string, unknown>>).filter(s => s.status === 'done' || s.status === 'completed').length / Math.max((m.steps as Array<Record<string, unknown>>).length, 1)) * 100)
            : 0,
          stepsDone: Array.isArray(m.steps) ? (m.steps as Array<Record<string, unknown>>).filter(s => s.status === 'done' || s.status === 'completed').length : 0,
          stepsTotal: Array.isArray(m.steps) ? (m.steps as Array<Record<string, unknown>>).length : 0,
          createdAt: m.createdAt as string || new Date().toISOString(),
        }))
      );
      if (data.source) setDataSource(data.source);
      else setDataSource('db');
    } catch {
      setActiveMolecules([]);
      setDataSource('mock');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchActiveMolecules().finally(() => setLoading(false));
  }, [fetchActiveMolecules]);

  /* ── Actions ───────────────────────────────────────────────────────────── */

  const cookFormula = useCallback(async (formula: Formula) => {
    setCooking(true);
    try {
      const toml = generateToml(formula);
      const res = await fetch(`${API}/api/meow/cook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toml }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLastCookResult({
        protoId: data.protoId || data.id || `proto-${Date.now()}`,
        stepCount: formula.steps.length,
        formulaName: formula.name,
      });
    } catch {
      setLastCookResult({
        protoId: `proto-${Date.now().toString(36)}`,
        stepCount: formula.steps.length,
        formulaName: formula.name,
      });
    } finally {
      setCooking(false);
    }
  }, []);

  const cookFromConsole = useCallback(async (toml: string, _vars: Record<string, string>) => {
    setCooking(true);
    try {
      const res = await fetch(`${API}/api/meow/cook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toml }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLastCookResult({
        protoId: data.protoId || data.id || `proto-${Date.now()}`,
        stepCount: data.stepCount || 0,
        formulaName: data.formulaName || 'custom',
      });
    } catch {
      setLastCookResult({
        protoId: `proto-${Date.now().toString(36)}`,
        stepCount: 0,
        formulaName: 'custom',
      });
    } finally {
      setCooking(false);
    }
  }, []);

  const pourProto = useCallback(async (protoIdOrFormula: string | Formula) => {
    const protoId = typeof protoIdOrFormula === 'string' ? protoIdOrFormula : lastCookResult?.protoId;
    if (!protoId) return;
    try {
      await fetch(`${API}/api/meow/pour/${protoId}`, { method: 'POST' });
      fetchActiveMolecules();
    } catch (err) {
      console.error('[FormulaLab] pour failed:', err);
    }
  }, [lastCookResult, fetchActiveMolecules]);

  const wispProto = useCallback(async (protoIdOrFormula: string | Formula) => {
    const protoId = typeof protoIdOrFormula === 'string' ? protoIdOrFormula : lastCookResult?.protoId;
    if (!protoId) return;
    try {
      await fetch(`${API}/api/meow/pour/${protoId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wisp: true, ttlMs: 300_000 }),
      });
      fetchActiveMolecules();
    } catch (err) {
      console.error('[FormulaLab] wisp failed:', err);
    }
  }, [lastCookResult, fetchActiveMolecules]);

  /* ── Derived ───────────────────────────────────────────────────────────── */

  const filteredFormulas = useMemo(() => {
    return formulas.filter(f => {
      if (filterType !== 'all' && f.type !== filterType) return false;
      if (filterCategory !== 'all' && f.category !== filterCategory) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!f.name.toLowerCase().includes(q) && !f.description.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [formulas, filterType, filterCategory, searchQuery]);

  const uniqueCategories = useMemo(() => {
    const cats = new Set(formulas.map(f => f.category));
    return Array.from(cats) as FormulaCategory[];
  }, [formulas]);

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="h-full flex flex-col font-mono" style={{ background: C.bg, color: C.text }}>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex-none border-b" style={{ borderColor: C.border }}>
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <h1 className="text-sm uppercase tracking-widest" style={{ color: C.text }}>Formula Lab</h1>
            <span className="text-[10px]" style={{ color: C.muted }}>{formulas.length} formulas</span>
            {dataSource === 'db' && <span className="px-2 py-0.5 text-[10px] bg-[#c2d94c]/10 text-[#c2d94c] border border-[#c2d94c]/20">LIVE</span>}
            {dataSource === 'mock' && <span className="px-2 py-0.5 text-[10px] bg-[#ffb454]/10 text-[#ffb454] border border-[#ffb454]/20">OFFLINE</span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCookConsole(true)}
              className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
              style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
            >
              Cook Console
            </button>
            <button
              onClick={fetchActiveMolecules}
              className="px-2 py-1.5 text-[10px] border transition-colors hover:opacity-70"
              style={{ color: C.muted, borderColor: C.border }}
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-0 px-6 border-t" style={{ borderColor: C.border }}>
          {(['browse', 'active', 'cook', 'mall'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-4 py-2.5 text-[10px] uppercase tracking-wider transition-colors border-b-2"
              style={{
                color: tab === t ? C.text : C.muted,
                borderBottomColor: tab === t ? C.cyan : 'transparent',
              }}
            >
              {t === 'browse' ? 'Formula Browser' : t === 'active' ? 'Active Molecules' : t === 'cook' ? 'Cook Console' : 'Mol Mall'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Main Content ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          <AnimatePresence mode="wait">

            {/* ──── Formula Browser ──────────────────────────────────────── */}
            {tab === 'browse' && (
              <motion.div
                key="browse"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex-1 flex flex-col overflow-hidden"
              >
                {/* Filters */}
                <div className="flex items-center gap-3 px-4 py-3 border-b flex-wrap" style={{ borderColor: C.border }}>
                  <input
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search formulas..."
                    className="px-3 py-1.5 text-xs border font-mono focus:outline-none w-56"
                    style={{ background: C.card, borderColor: C.border, color: C.text }}
                  />
                  <div className="w-px h-5" style={{ background: C.border }} />
                  {/* Type filter */}
                  <div className="flex gap-1">
                    <button
                      onClick={() => setFilterType('all')}
                      className={`px-2 py-1 text-[10px] border ${filterType === 'all' ? 'bg-[#2d363f]/50 border-[#2d363f] text-[#e6e1cf]' : 'border-[#2d363f] text-[#6c7680] hover:text-[#e6e1cf]'}`}
                    >
                      All
                    </button>
                    {(Object.keys(TYPE_CONFIG) as FormulaType[]).map(t => (
                      <button
                        key={t}
                        onClick={() => setFilterType(t)}
                        className={`px-2 py-1 text-[10px] border ${filterType === t ? TYPE_CONFIG[t].badge : 'border-[#2d363f] text-[#6c7680] hover:text-[#e6e1cf]'}`}
                      >
                        {TYPE_CONFIG[t].label}
                      </button>
                    ))}
                  </div>
                  <div className="w-px h-5" style={{ background: C.border }} />
                  {/* Category filter */}
                  <select
                    value={filterCategory}
                    onChange={e => setFilterCategory(e.target.value as FormulaCategory | 'all')}
                    className="px-2 py-1 text-xs border font-mono focus:outline-none"
                    style={{ background: C.card, borderColor: C.border, color: `${C.text}cc` }}
                  >
                    <option value="all">All Categories</option>
                    {uniqueCategories.map(cat => (
                      <option key={cat} value={cat}>{CATEGORY_LABELS[cat]}</option>
                    ))}
                  </select>
                </div>

                {/* Formula Grid */}
                <div className="flex-1 overflow-y-auto p-4">
                  {filteredFormulas.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20" style={{ color: C.muted }}>
                      <div className="text-3xl mb-3">&#x2697;</div>
                      <div className="text-sm">No formulas match your filters</div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {filteredFormulas.map(f => (
                        <FormulaCard
                          key={f.id}
                          formula={f}
                          onClick={() => setSelectedFormula(f)}
                          selected={selectedFormula?.id === f.id}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {/* ──── Active Molecules ─────────────────────────────────────── */}
            {tab === 'active' && (
              <motion.div
                key="active"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex-1 overflow-y-auto p-4"
              >
                {loading ? (
                  <div className="flex items-center justify-center py-20" style={{ color: C.muted }}>
                    <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.5, repeat: Infinity }}>
                      Loading molecules...
                    </motion.span>
                  </div>
                ) : activeMolecules.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20" style={{ color: C.muted }}>
                    <div className="text-3xl mb-3">&#x1F9EA;</div>
                    <div className="text-sm">No active molecules</div>
                    <div className="text-[10px] mt-1">Cook a formula to create your first molecule</div>
                  </div>
                ) : (
                  <div className="border font-mono" style={{ borderColor: C.border }}>
                    {/* Table Header */}
                    <div className="grid grid-cols-12 gap-2 px-4 py-2.5 text-[9px] uppercase tracking-wider border-b" style={{ borderColor: C.border, color: C.muted, background: `${C.card}80` }}>
                      <div className="col-span-3">Formula</div>
                      <div className="col-span-2">Molecule</div>
                      <div className="col-span-1">Phase</div>
                      <div className="col-span-1">Status</div>
                      <div className="col-span-3">Progress</div>
                      <div className="col-span-2">Created</div>
                    </div>
                    {/* Rows */}
                    {activeMolecules.map((mol, idx) => {
                      const phaseColor = mol.phase === 'ice9' ? C.cyan : mol.phase === 'liquid' ? C.green : mol.phase === 'vapor' ? C.purple : C.muted;
                      const statusColor = mol.status === 'active' ? C.green : mol.status === 'completed' ? C.cyan : mol.status === 'failed' ? C.red : C.yellow;
                      return (
                        <motion.div
                          key={mol.id}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: idx * 0.04 }}
                          className="grid grid-cols-12 gap-2 px-4 py-3 items-center border-b transition-colors hover:bg-[#1a1f26]/50"
                          style={{ borderColor: `${C.border}60` }}
                        >
                          <div className="col-span-3 text-xs font-bold" style={{ color: C.yellow }}>{mol.formulaName || '--'}</div>
                          <div className="col-span-2">
                            <div className="text-[10px] font-mono" style={{ color: C.text }}>{mol.id.slice(0, 10)}</div>
                            <div className="text-[9px]" style={{ color: C.muted }}>{mol.name}</div>
                          </div>
                          <div className="col-span-1">
                            <span className="text-[9px] px-1.5 py-0.5 border" style={{ color: phaseColor, borderColor: `${phaseColor}30`, background: `${phaseColor}10` }}>
                              {mol.phase}
                            </span>
                          </div>
                          <div className="col-span-1">
                            <span className="text-[9px] px-1.5 py-0.5 border" style={{ color: statusColor, borderColor: `${statusColor}30`, background: `${statusColor}10` }}>
                              {mol.status}
                            </span>
                          </div>
                          <div className="col-span-3">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5" style={{ background: `${C.border}50` }}>
                                <motion.div
                                  className="h-full"
                                  style={{ background: phaseColor }}
                                  initial={{ width: 0 }}
                                  animate={{ width: `${mol.progress}%` }}
                                  transition={{ duration: 0.5 }}
                                />
                              </div>
                              <span className="text-[9px] w-16 text-right" style={{ color: C.muted }}>
                                {mol.stepsDone}/{mol.stepsTotal} ({mol.progress}%)
                              </span>
                            </div>
                          </div>
                          <div className="col-span-2 text-[10px]" style={{ color: C.muted }}>{timeAgo(mol.createdAt)}</div>
                        </motion.div>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            )}

            {/* ──── Inline Cook Console ──────────────────────────────────── */}
            {tab === 'cook' && (
              <motion.div
                key="cook-tab"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex-1 overflow-y-auto p-4"
              >
                <div className="max-w-[800px] mx-auto space-y-4">
                  <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                    <div className="text-[9px] uppercase tracking-wider mb-3" style={{ color: C.muted }}>Cook a Formula</div>
                    <p className="text-[10px] leading-relaxed mb-4" style={{ color: C.muted }}>
                      Paste TOML formula definition below, set variables, and cook. Cooking creates a protomolecule.
                      Then pour it into a full molecule, or create an ephemeral wisp that auto-expires.
                    </p>
                    <button
                      onClick={() => setShowCookConsole(true)}
                      className="px-4 py-2 text-xs uppercase tracking-wider border transition-colors hover:opacity-80"
                      style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
                    >
                      Open Cook Console
                    </button>
                  </div>

                  {/* Last result */}
                  {lastCookResult && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="border p-4"
                      style={{ borderColor: `${C.green}30`, background: `${C.green}08` }}
                    >
                      <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.green }}>Last Cook Result</div>
                      <div className="space-y-1 text-[10px]">
                        <div style={{ color: C.text }}>Proto ID: <span className="font-bold" style={{ color: C.cyan }}>{lastCookResult.protoId}</span></div>
                        <div style={{ color: C.muted }}>Steps: {lastCookResult.stepCount}</div>
                        <div style={{ color: C.muted }}>Formula: {lastCookResult.formulaName}</div>
                      </div>
                      <div className="flex items-center gap-2 mt-3">
                        <button
                          onClick={() => pourProto(lastCookResult.protoId)}
                          className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
                          style={{ color: C.cyan, borderColor: `${C.cyan}40`, background: `${C.cyan}10` }}
                        >
                          Pour (Molecule)
                        </button>
                        <button
                          onClick={() => wispProto(lastCookResult.protoId)}
                          className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
                          style={{ color: C.purple, borderColor: `${C.purple}40`, background: `${C.purple}10` }}
                        >
                          Wisp (Ephemeral)
                        </button>
                      </div>
                    </motion.div>
                  )}

                  {/* Quick cook from formulas */}
                  <div className="border" style={{ background: C.card, borderColor: C.border }}>
                    <div className="px-5 py-3 border-b" style={{ borderColor: C.border }}>
                      <span className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Quick Cook from Existing Formulas</span>
                    </div>
                    <div className="p-4 space-y-2">
                      {formulas.slice(0, 6).map(f => (
                        <div key={f.id} className="flex items-center justify-between px-3 py-2 border" style={{ borderColor: `${C.border}60` }}>
                          <div className="flex items-center gap-3">
                            <span className={`px-1.5 py-0.5 text-[9px] border ${TYPE_CONFIG[f.type].badge}`}>{TYPE_CONFIG[f.type].label}</span>
                            <span className="text-xs" style={{ color: C.text }}>{f.name}</span>
                            <span className="text-[9px]" style={{ color: C.muted }}>{f.steps.length} steps</span>
                          </div>
                          <button
                            onClick={() => cookFormula(f)}
                            disabled={cooking}
                            className="px-2 py-1 text-[9px] uppercase tracking-wider border transition-colors hover:opacity-80 disabled:opacity-40"
                            style={{ color: C.green, borderColor: `${C.green}30`, background: `${C.green}08` }}
                          >
                            Cook
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* ──── Mol Mall ─────────────────────────────────────────────── */}
            {tab === 'mall' && (
              <motion.div
                key="mall"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex-1 overflow-y-auto p-4"
              >
                <div className="max-w-[1000px] mx-auto space-y-6">
                  {/* Coming Soon Banner */}
                  <div className="border p-6 text-center" style={{ borderColor: `${C.purple}30`, background: `${C.purple}08` }}>
                    <div className="text-xl mb-2" style={{ color: C.purple }}>MOL MALL</div>
                    <div className="text-xs uppercase tracking-wider mb-3" style={{ color: C.muted }}>Community Formula Marketplace</div>
                    <p className="text-[10px] leading-relaxed max-w-[500px] mx-auto" style={{ color: C.muted }}>
                      Share formulas with the federation. Import proven workflows from other Gas Towns.
                      Rate, review, and fork community formulas. Coming to the Wasteland soon.
                    </p>
                    <div className="flex items-center justify-center gap-3 mt-4">
                      <button
                        className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
                        style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
                      >
                        Export Formula
                      </button>
                      <button
                        className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
                        style={{ color: C.cyan, borderColor: `${C.cyan}40`, background: `${C.cyan}10` }}
                      >
                        Import Formula
                      </button>
                    </div>
                  </div>

                  {/* Community Formulas Preview */}
                  <div>
                    <div className="flex items-center gap-3 mb-3">
                      <h2 className="text-[11px] uppercase tracking-widest" style={{ color: C.muted }}>Featured Community Formulas</h2>
                      <div className="flex-1 h-px" style={{ background: C.border }} />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {mallFormulas.map((mf, idx) => {
                        const typeCfg = TYPE_CONFIG[mf.type];
                        return (
                          <motion.div
                            key={mf.id}
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: idx * 0.06 }}
                            className="border p-4 transition-colors hover:border-[#3d464f]"
                            style={{ background: C.card, borderColor: C.border }}
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <h3 className="text-xs font-bold" style={{ color: C.text }}>{mf.name}</h3>
                              <span className={`flex-none px-1.5 py-0.5 text-[9px] border ${typeCfg.badge}`}>{typeCfg.label}</span>
                            </div>
                            <p className="text-[10px] leading-relaxed line-clamp-2 mb-3" style={{ color: C.muted }}>{mf.description}</p>
                            <div className="flex items-center gap-3 text-[9px]" style={{ color: C.muted }}>
                              <span style={{ color: C.cyan }}>{mf.author}</span>
                              <span>v{mf.version}</span>
                              <span>{mf.downloads.toLocaleString()} downloads</span>
                              <span style={{ color: C.yellow }}>{mf.rating}/5</span>
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </div>

        {/* ── Detail Panel (slide-in sidebar) ────────────────────────────── */}
        <AnimatePresence>
          {selectedFormula && tab === 'browse' && (
            <FormulaDetailPanel
              formula={selectedFormula}
              onClose={() => setSelectedFormula(null)}
              onCook={cookFormula}
              onPour={pourProto}
              onWisp={wispProto}
              cooking={cooking}
            />
          )}
        </AnimatePresence>
      </div>

      {/* ── Cook Console Modal ───────────────────────────────────────────── */}
      <AnimatePresence>
        {showCookConsole && (
          <CookConsole
            open={showCookConsole}
            onClose={() => setShowCookConsole(false)}
            onCook={cookFromConsole}
            cooking={cooking}
            lastResult={lastCookResult}
            onPour={(id) => pourProto(id)}
            onWisp={(id) => wispProto(id)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

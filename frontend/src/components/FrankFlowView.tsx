'use client';

/**
 * FrankFlowView — GT-013: FrankFlow Quality & Routing Engine
 *
 * 4-tab inspector for FrankFlow subsystems:
 *   Router  — NLP intent classification & specialist routing
 *   Gates   — Multi-stack quality pipeline (lint, typecheck, test, build)
 *   Review  — Multi-agent code review with auto-fix loop
 *   Patterns — Adaptive error memory & pattern learner
 *
 * Ayu Dark aesthetic: bg-[#0f1419], borders [#2d363f], text [#e6e1cf], font-mono.
 * Polls /api/frankflow every 10s for live stats.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────

type TabId = 'router' | 'gates' | 'review' | 'patterns';

interface ModuleStats {
  [key: string]: number | string | boolean | undefined;
}

interface OverviewData {
  name: string;
  version: string;
  modules: {
    checkpoints: { stats: ModuleStats };
    orphans: { stats: ModuleStats; loopRunning: boolean };
    retries: { stats: ModuleStats };
    router: { stats: ModuleStats };
    patterns: { stats: ModuleStats };
    quality: { stats: ModuleStats };
  };
}

interface RouteCategory {
  id: string;
  specialist: string;
  priority: number;
  workflow?: string;
  patternCount: number;
  contextInjection: string;
}

interface RouteHistoryEntry {
  text: string;
  category: string;
  specialist: string;
  confidence: number;
  timestamp: string;
}

interface RouteStatsData {
  totalRouted: number;
  categoryBreakdown: Record<string, number>;
  avgConfidence: number;
}

interface QualityReport {
  id: string;
  beadId?: string;
  branch?: string;
  passed: boolean;
  stacks: string[];
  gateResults: GateResult[];
  createdAt: string;
  durationMs?: number;
}

interface GateResult {
  gate: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

interface QualityStatsData {
  totalRuns: number;
  passRate: number;
  avgDuration: number;
  gateBreakdown: Record<string, { runs: number; passes: number; rate: number }>;
}

interface ReviewEntry {
  id: string;
  beadId?: string;
  passed: boolean;
  totalFindings: number;
  criticalCount: number;
  autoFixCount: number;
  agents: string[];
  createdAt: string;
}

interface ReviewAgent {
  id: string;
  name: string;
  focus: string;
  severity: string;
}

interface ErrorPattern {
  id: string;
  signature: string;
  category: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  resolution?: string;
  beadIds: string[];
}

interface PatternStatsData {
  totalPatterns: number;
  activePatterns: number;
  resolvedPatterns: number;
  categoryBreakdown: Record<string, number>;
  topPatterns: Array<{ signature: string; count: number }>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL = 10000;

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'router', label: 'Router', icon: '\u2192' },
  { id: 'gates', label: 'Gates', icon: '\u2588' },
  { id: 'review', label: 'Review', icon: '\u2691' },
  { id: 'patterns', label: 'Patterns', icon: '\u25C8' },
];

const GATE_PIPELINE = ['lint', 'typecheck', 'test', 'build'] as const;

const GATE_ICONS: Record<string, string> = {
  lint: '\u2261',
  typecheck: 'TS',
  test: '\u25B6',
  build: '\u25A0',
  security: '\u26A0',
};

// ─── Fallback Data ──────────────────────────────────────────────────────────

const FALLBACK_OVERVIEW: OverviewData = {
  name: 'FrankFlow Execution Logic Layer',
  version: '1.0.0',
  modules: {
    checkpoints: { stats: { total: 0, active: 0 } },
    orphans: { stats: { detected: 0, recovered: 0 }, loopRunning: false },
    retries: { stats: { total: 0, pending: 0, exhausted: 0 } },
    router: { stats: { totalRouted: 0, categoryCount: 13 } },
    patterns: { stats: { totalPatterns: 0, activePatterns: 0, resolvedPatterns: 0 } },
    quality: { stats: { totalRuns: 0, passRate: 0 } },
  },
};

const FALLBACK_CATEGORIES: RouteCategory[] = [
  { id: 'frontend', specialist: 'fe-worker', priority: 80, patternCount: 12, contextInjection: 'React/Next.js/CSS/HTML component development...' },
  { id: 'backend', specialist: 'be-worker', priority: 80, patternCount: 10, contextInjection: 'Express/Node.js/API/database...' },
  { id: 'testing', specialist: 'qa-worker', priority: 70, patternCount: 8, contextInjection: 'Jest/Vitest/testing patterns...' },
  { id: 'devops', specialist: 'ops-worker', priority: 60, patternCount: 6, contextInjection: 'Docker/CI-CD/deploy/infrastructure...' },
  { id: 'database', specialist: 'db-worker', priority: 75, patternCount: 7, contextInjection: 'SQL/Postgres/migrations/schema...' },
  { id: 'security', specialist: 'sec-worker', priority: 90, patternCount: 5, contextInjection: 'Auth/JWT/CORS/vulnerability scanning...' },
  { id: 'documentation', specialist: 'docs-worker', priority: 40, patternCount: 4, contextInjection: 'Markdown/README/JSDoc...' },
  { id: 'refactoring', specialist: 'refactor-worker', priority: 65, patternCount: 6, contextInjection: 'Code cleanup/DRY/SOLID...' },
  { id: 'bugfix', specialist: 'debug-worker', priority: 85, patternCount: 9, contextInjection: 'Error tracing/stack analysis/fix...' },
  { id: 'api-design', specialist: 'api-worker', priority: 70, patternCount: 5, contextInjection: 'REST/OpenAPI/routes/middleware...' },
  { id: 'performance', specialist: 'perf-worker', priority: 55, patternCount: 4, contextInjection: 'Profiling/caching/optimization...' },
  { id: 'styling', specialist: 'ui-worker', priority: 50, patternCount: 6, contextInjection: 'Tailwind/CSS modules/theme...' },
  { id: 'config', specialist: 'config-worker', priority: 45, patternCount: 3, contextInjection: 'Env vars/config files/dotenv...' },
];

const FALLBACK_ROUTE_STATS: RouteStatsData = {
  totalRouted: 247,
  avgConfidence: 0.82,
  categoryBreakdown: {
    frontend: 52, backend: 48, bugfix: 35, testing: 28, database: 22,
    refactoring: 18, security: 12, devops: 10, 'api-design': 8,
    documentation: 6, performance: 4, styling: 3, config: 1,
  },
};

const FALLBACK_ROUTE_HISTORY: RouteHistoryEntry[] = [
  { text: 'Fix the login form validation error', category: 'bugfix', specialist: 'debug-worker', confidence: 0.91, timestamp: new Date(Date.now() - 120000).toISOString() },
  { text: 'Add Stripe webhook endpoint', category: 'backend', specialist: 'be-worker', confidence: 0.88, timestamp: new Date(Date.now() - 240000).toISOString() },
  { text: 'Update the product card component', category: 'frontend', specialist: 'fe-worker', confidence: 0.94, timestamp: new Date(Date.now() - 360000).toISOString() },
  { text: 'Write unit tests for auth service', category: 'testing', specialist: 'qa-worker', confidence: 0.86, timestamp: new Date(Date.now() - 480000).toISOString() },
  { text: 'Create migration for orders table', category: 'database', specialist: 'db-worker', confidence: 0.92, timestamp: new Date(Date.now() - 600000).toISOString() },
];

const FALLBACK_QUALITY_STATS: QualityStatsData = {
  totalRuns: 134,
  passRate: 0.78,
  avgDuration: 12400,
  gateBreakdown: {
    lint: { runs: 134, passes: 118, rate: 0.88 },
    typecheck: { runs: 134, passes: 112, rate: 0.84 },
    test: { runs: 130, passes: 98, rate: 0.75 },
    build: { runs: 98, passes: 89, rate: 0.91 },
  },
};

const FALLBACK_QUALITY_REPORTS: QualityReport[] = [
  {
    id: 'qr-001', beadId: 'bead-42', branch: 'feat/checkout', passed: true,
    stacks: ['node', 'react'], gateResults: [
      { gate: 'lint', passed: true, output: '0 problems', durationMs: 1200 },
      { gate: 'typecheck', passed: true, output: '0 errors', durationMs: 3400 },
      { gate: 'test', passed: true, output: '42 tests passed', durationMs: 5800 },
      { gate: 'build', passed: true, output: 'Build succeeded', durationMs: 2100 },
    ], createdAt: new Date(Date.now() - 300000).toISOString(), durationMs: 12500,
  },
  {
    id: 'qr-002', beadId: 'bead-43', branch: 'fix/auth-token', passed: false,
    stacks: ['node'], gateResults: [
      { gate: 'lint', passed: true, output: '0 problems', durationMs: 900 },
      { gate: 'typecheck', passed: false, output: 'TS2322: Type mismatch in auth.ts:44', durationMs: 2800 },
      { gate: 'test', passed: false, output: '3 tests failed', durationMs: 4200 },
      { gate: 'build', passed: false, output: 'Build failed (typecheck errors)', durationMs: 0 },
    ], createdAt: new Date(Date.now() - 600000).toISOString(), durationMs: 7900,
  },
  {
    id: 'qr-003', beadId: 'bead-41', branch: 'refactor/db-layer', passed: true,
    stacks: ['node'], gateResults: [
      { gate: 'lint', passed: true, output: '0 problems', durationMs: 1100 },
      { gate: 'typecheck', passed: true, output: '0 errors', durationMs: 3100 },
      { gate: 'test', passed: true, output: '67 tests passed', durationMs: 7200 },
      { gate: 'build', passed: true, output: 'Build succeeded', durationMs: 1800 },
    ], createdAt: new Date(Date.now() - 900000).toISOString(), durationMs: 13200,
  },
];

const FALLBACK_REVIEWS: ReviewEntry[] = [
  { id: 'rv-001', beadId: 'bead-42', passed: true, totalFindings: 3, criticalCount: 0, autoFixCount: 1, agents: ['security-agent', 'style-agent'], createdAt: new Date(Date.now() - 180000).toISOString() },
  { id: 'rv-002', beadId: 'bead-43', passed: false, totalFindings: 7, criticalCount: 2, autoFixCount: 2, agents: ['security-agent', 'perf-agent', 'style-agent'], createdAt: new Date(Date.now() - 360000).toISOString() },
  { id: 'rv-003', beadId: 'bead-40', passed: true, totalFindings: 1, criticalCount: 0, autoFixCount: 0, agents: ['style-agent'], createdAt: new Date(Date.now() - 540000).toISOString() },
];

const FALLBACK_REVIEW_AGENTS: ReviewAgent[] = [
  { id: 'security-agent', name: 'Security Sentinel', focus: 'Vulnerabilities, auth, injection', severity: 'critical' },
  { id: 'perf-agent', name: 'Performance Hawk', focus: 'N+1 queries, memory leaks, bundle size', severity: 'warning' },
  { id: 'style-agent', name: 'Style Guardian', focus: 'Naming, structure, DRY, SOLID', severity: 'info' },
  { id: 'test-agent', name: 'Test Inspector', focus: 'Coverage gaps, edge cases, mocking', severity: 'warning' },
];

const FALLBACK_PATTERNS: ErrorPattern[] = [
  { id: 'pat-001', signature: 'TS2322: Type .* is not assignable', category: 'type_error', count: 14, firstSeen: new Date(Date.now() - 86400000 * 3).toISOString(), lastSeen: new Date(Date.now() - 3600000).toISOString(), resolution: 'Check interface alignment', beadIds: ['bead-40', 'bead-43'] },
  { id: 'pat-002', signature: 'Cannot find module .*', category: 'import_error', count: 8, firstSeen: new Date(Date.now() - 86400000 * 2).toISOString(), lastSeen: new Date(Date.now() - 7200000).toISOString(), beadIds: ['bead-38'] },
  { id: 'pat-003', signature: 'ECONNREFUSED .*:5432', category: 'network_error', count: 5, firstSeen: new Date(Date.now() - 86400000).toISOString(), lastSeen: new Date(Date.now() - 14400000).toISOString(), resolution: 'Ensure DB container is running', beadIds: [] },
  { id: 'pat-004', signature: 'Jest: Exceeded timeout of \\d+ms', category: 'timeout', count: 11, firstSeen: new Date(Date.now() - 86400000 * 5).toISOString(), lastSeen: new Date(Date.now() - 1800000).toISOString(), beadIds: ['bead-41', 'bead-42'] },
  { id: 'pat-005', signature: 'ESLint: no-unused-vars', category: 'lint_error', count: 22, firstSeen: new Date(Date.now() - 86400000 * 7).toISOString(), lastSeen: new Date(Date.now() - 900000).toISOString(), resolution: 'Prefix with underscore or remove', beadIds: ['bead-39', 'bead-43'] },
  { id: 'pat-006', signature: 'SyntaxError: Unexpected token', category: 'syntax_error', count: 3, firstSeen: new Date(Date.now() - 86400000).toISOString(), lastSeen: new Date(Date.now() - 43200000).toISOString(), beadIds: [] },
];

const FALLBACK_PATTERN_STATS: PatternStatsData = {
  totalPatterns: 6,
  activePatterns: 4,
  resolvedPatterns: 2,
  categoryBreakdown: { type_error: 14, lint_error: 22, timeout: 11, import_error: 8, network_error: 5, syntax_error: 3 },
  topPatterns: [
    { signature: 'ESLint: no-unused-vars', count: 22 },
    { signature: 'TS2322: Type mismatch', count: 14 },
    { signature: 'Jest: Exceeded timeout', count: 11 },
  ],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function ago(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function ms(n: number): string {
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

async function fetchJSON<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch {
    return fallback;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function FrankFlowView() {
  const [tab, setTab] = useState<TabId>('router');
  const [overview, setOverview] = useState<OverviewData>(FALLBACK_OVERVIEW);
  const [dataSource, setDataSource] = useState<'live' | 'fallback'>('fallback');

  // Router tab state
  const [categories, setCategories] = useState<RouteCategory[]>(FALLBACK_CATEGORIES);
  const [routeStats, setRouteStats] = useState<RouteStatsData>(FALLBACK_ROUTE_STATS);
  const [routeHistory, setRouteHistory] = useState<RouteHistoryEntry[]>(FALLBACK_ROUTE_HISTORY);

  // Gates tab state
  const [qualityStats, setQualityStats] = useState<QualityStatsData>(FALLBACK_QUALITY_STATS);
  const [qualityReports, setQualityReports] = useState<QualityReport[]>(FALLBACK_QUALITY_REPORTS);

  // Review tab state
  const [reviews, setReviews] = useState<ReviewEntry[]>(FALLBACK_REVIEWS);
  const [reviewAgents, setReviewAgents] = useState<ReviewAgent[]>(FALLBACK_REVIEW_AGENTS);

  // Patterns tab state
  const [patterns, setPatterns] = useState<ErrorPattern[]>(FALLBACK_PATTERNS);
  const [patternStats, setPatternStats] = useState<PatternStatsData>(FALLBACK_PATTERN_STATS);

  // ── Fetch ──────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    // Overview (always fetch)
    const ov = await fetchJSON<{ modules?: OverviewData['modules'] }>(
      `${API}/api/frankflow`, {},
    );
    if (ov.modules) {
      setOverview(prev => ({ ...prev, modules: ov.modules! }));
      setDataSource('live');
    }

    // Tab-specific fetches
    if (tab === 'router') {
      const [catRes, histRes] = await Promise.all([
        fetchJSON<{ categories?: RouteCategory[]; stats?: RouteStatsData }>(
          `${API}/api/frankflow/routes`, {},
        ),
        fetchJSON<{ history?: RouteHistoryEntry[] }>(
          `${API}/api/frankflow/routes/history?limit=20`, {},
        ),
      ]);
      if (catRes.categories) setCategories(catRes.categories);
      if (catRes.stats) setRouteStats(catRes.stats);
      if (histRes.history) setRouteHistory(histRes.history);
    }

    if (tab === 'gates') {
      const qRes = await fetchJSON<{ reports?: QualityReport[]; stats?: QualityStatsData }>(
        `${API}/api/frankflow/quality?limit=20`, {},
      );
      if (qRes.reports) setQualityReports(qRes.reports);
      if (qRes.stats) setQualityStats(qRes.stats);
    }

    if (tab === 'review') {
      const [rvRes, agRes] = await Promise.all([
        fetchJSON<{ reviews?: ReviewEntry[] }>(
          `${API}/api/frankflow/review?limit=20`, {},
        ),
        fetchJSON<{ agents?: ReviewAgent[] }>(
          `${API}/api/frankflow/review/agents`, {},
        ),
      ]);
      if (rvRes.reviews) setReviews(rvRes.reviews);
      if (agRes.agents) setReviewAgents(agRes.agents);
    }

    if (tab === 'patterns') {
      const pRes = await fetchJSON<{ patterns?: ErrorPattern[]; stats?: PatternStatsData }>(
        `${API}/api/frankflow/patterns`, {},
      );
      if (pRes.patterns) setPatterns(pRes.patterns);
      if (pRes.stats) setPatternStats(pRes.stats);
    }
  }, [tab]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // ── Computed ───────────────────────────────────────────────────────────

  const headerStats = useMemo(() => {
    const m = overview.modules;
    return [
      { label: 'Routed', value: String(routeStats.totalRouted || m.router.stats.totalRouted || 0), color: 'text-cyan-400' },
      { label: 'Gate Runs', value: String(qualityStats.totalRuns || m.quality.stats.totalRuns || 0), color: 'text-emerald-400' },
      { label: 'Pass Rate', value: pct(Number(qualityStats.passRate || m.quality.stats.passRate || 0)), color: 'text-amber-400' },
      { label: 'Patterns', value: String(patternStats.totalPatterns || m.patterns.stats.totalPatterns || 0), color: 'text-purple-400' },
      { label: 'Checkpoints', value: String(m.checkpoints.stats.total || 0), color: 'text-zinc-400' },
      { label: 'Orphans', value: String(m.orphans.stats.detected || 0), color: 'text-red-400' },
    ];
  }, [overview, routeStats, qualityStats, patternStats]);

  const sortedCategoryBreakdown = useMemo(() => {
    return Object.entries(routeStats.categoryBreakdown || {})
      .sort(([, a], [, b]) => b - a);
  }, [routeStats]);

  const sortedPatternCategories = useMemo(() => {
    return Object.entries(patternStats.categoryBreakdown || {})
      .sort(([, a], [, b]) => b - a);
  }, [patternStats]);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen p-4 font-mono text-[#e6e1cf]" style={{ background: '#0f1419' }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <span className="text-lg text-[#ffb454]">{'\u25C6'}</span>
            <h1 className="text-base text-[#e6e1cf]">FrankFlow</h1>
            <span className="text-[10px] text-[#6c7680]">Quality & Routing Engine</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-none border" style={{
              color: dataSource === 'live' ? '#95e6cb' : '#ffb454',
              background: dataSource === 'live' ? '#95e6cb10' : '#ffb45410',
              borderColor: dataSource === 'live' ? '#95e6cb30' : '#ffb45430',
            }}>
              {dataSource === 'live' ? '\u2713 LIVE' : '\u25CB DEMO'}
            </span>
          </div>
          <span className="text-[9px] text-[#6c7680]">v{overview.version}</span>
        </div>

        {/* Stats row */}
        <div className="flex gap-3 flex-wrap">
          {headerStats.map(s => (
            <div key={s.label} className="px-3 py-2 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
              <div className={`text-sm font-bold ${s.color}`}>{s.value}</div>
              <div className="text-[9px] text-[#6c7680] mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Tab Bar ────────────────────────────────────────────────────── */}
      <div className="flex gap-1 mb-4 border-b" style={{ borderColor: '#2d363f' }}>
        {TABS.map(t => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="px-4 py-2 text-xs rounded-none transition-all relative"
              style={{
                color: active ? '#e6e1cf' : '#6c7680',
                background: active ? '#1a1f2610' : 'transparent',
              }}
            >
              <span className="mr-1.5">{t.icon}</span>
              {t.label}
              {active && (
                <motion.div
                  layoutId="ff-tab-indicator"
                  className="absolute bottom-0 left-0 right-0 h-px"
                  style={{ background: '#ffb454' }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* ── Tab Content ────────────────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.15 }}
        >
          {tab === 'router' && (
            <RouterTab
              categories={categories}
              stats={routeStats}
              history={routeHistory}
              breakdown={sortedCategoryBreakdown}
            />
          )}
          {tab === 'gates' && (
            <GatesTab
              stats={qualityStats}
              reports={qualityReports}
            />
          )}
          {tab === 'review' && (
            <ReviewTab
              reviews={reviews}
              agents={reviewAgents}
            />
          )}
          {tab === 'patterns' && (
            <PatternsTab
              patterns={patterns}
              stats={patternStats}
              categoryBreakdown={sortedPatternCategories}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Router Tab
// ═══════════════════════════════════════════════════════════════════════════

function RouterTab({
  categories,
  stats,
  history,
  breakdown,
}: {
  categories: RouteCategory[];
  stats: RouteStatsData;
  history: RouteHistoryEntry[];
  breakdown: [string, number][];
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Left: Category Distribution */}
      <div className="lg:col-span-1">
        <SectionHeader title="Category Distribution" count={breakdown.length} />
        <div className="space-y-1">
          {breakdown.map(([cat, count]) => {
            const maxCount = breakdown[0]?.[1] || 1;
            const widthPct = (count / maxCount) * 100;
            return (
              <div key={cat} className="flex items-center gap-2 px-3 py-1.5 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
                <span className="text-[10px] text-[#95e6cb] w-24 truncate">{cat}</span>
                <div className="flex-1 h-2 rounded-none" style={{ background: '#1a1f26' }}>
                  <div
                    className="h-full rounded-none transition-all"
                    style={{ width: `${widthPct}%`, background: '#95e6cb40' }}
                  />
                </div>
                <span className="text-[10px] text-[#e6e1cf] w-8 text-right">{count}</span>
              </div>
            );
          })}
        </div>

        {/* Route stats summary */}
        <div className="mt-4 px-3 py-3 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
          <div className="text-[9px] text-[#6c7680] mb-2 uppercase tracking-wider">Router Stats</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-sm text-cyan-400 font-bold">{stats.totalRouted}</div>
              <div className="text-[9px] text-[#6c7680]">Total Routed</div>
            </div>
            <div>
              <div className="text-sm text-amber-400 font-bold">{pct(stats.avgConfidence)}</div>
              <div className="text-[9px] text-[#6c7680]">Avg Confidence</div>
            </div>
          </div>
        </div>
      </div>

      {/* Center: Routing Categories */}
      <div className="lg:col-span-1">
        <SectionHeader title="Routing Categories" count={categories.length} />
        <div className="space-y-1 max-h-[600px] overflow-y-auto">
          {categories.map(cat => (
            <div key={cat.id} className="px-3 py-2 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-[#e6e1cf] font-bold">{cat.id}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-none" style={{ background: '#d2a6ff15', color: '#d2a6ff' }}>
                  P{cat.priority}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[9px] text-[#6c7680]">
                <span>{'\u2192'} {cat.specialist}</span>
                <span>{'\u00B7'}</span>
                <span>{cat.patternCount} patterns</span>
                {cat.workflow && (
                  <>
                    <span>{'\u00B7'}</span>
                    <span className="text-[#95e6cb]">{cat.workflow}</span>
                  </>
                )}
              </div>
              <div className="text-[8px] text-[#6c7680] mt-1 truncate">{cat.contextInjection}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: Recent Classifications */}
      <div className="lg:col-span-1">
        <SectionHeader title="Recent Classifications" count={history.length} />
        <div className="space-y-1">
          {history.map((entry, i) => (
            <div key={i} className="px-3 py-2 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
              <div className="text-[10px] text-[#e6e1cf] mb-1 line-clamp-2">{entry.text}</div>
              <div className="flex items-center gap-2 text-[9px]">
                <span className="text-[#95e6cb]">{entry.category}</span>
                <span className="text-[#6c7680]">{'\u2192'}</span>
                <span className="text-[#d2a6ff]">{entry.specialist}</span>
                <span className="text-[#6c7680]">{'\u00B7'}</span>
                <span className={entry.confidence > 0.85 ? 'text-emerald-400' : entry.confidence > 0.7 ? 'text-amber-400' : 'text-red-400'}>
                  {pct(entry.confidence)}
                </span>
                <span className="ml-auto text-[8px] text-[#6c7680]">{ago(entry.timestamp)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Gates Tab
// ═══════════════════════════════════════════════════════════════════════════

function GatesTab({
  stats,
  reports,
}: {
  stats: QualityStatsData;
  reports: QualityReport[];
}) {
  const [expandedReport, setExpandedReport] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {/* Gate Pipeline Overview */}
      <div>
        <SectionHeader title="Gate Pipeline" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {GATE_PIPELINE.map(gate => {
            const gateData = stats.gateBreakdown?.[gate];
            const rate = gateData?.rate || 0;
            const rateColor = rate > 0.85 ? 'text-emerald-400' : rate > 0.7 ? 'text-amber-400' : 'text-red-400';
            return (
              <div key={gate} className="px-4 py-3 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] text-[#6c7680] font-bold w-5">{GATE_ICONS[gate] || gate[0]}</span>
                  <span className="text-xs text-[#e6e1cf] uppercase">{gate}</span>
                </div>
                <div className={`text-2xl font-bold ${rateColor}`}>{pct(rate)}</div>
                <div className="text-[9px] text-[#6c7680] mt-1">
                  {gateData?.passes || 0}/{gateData?.runs || 0} passed
                </div>
                {/* Mini bar */}
                <div className="mt-2 h-1.5 rounded-none" style={{ background: '#1a1f26' }}>
                  <div
                    className="h-full rounded-none transition-all"
                    style={{
                      width: `${rate * 100}%`,
                      background: rate > 0.85 ? '#95e6cb' : rate > 0.7 ? '#ffb454' : '#f07178',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Pipeline Flow Visualization */}
      <div className="flex items-center justify-center gap-0 py-3">
        {GATE_PIPELINE.map((gate, i) => {
          const gateData = stats.gateBreakdown?.[gate];
          const rate = gateData?.rate || 0;
          const color = rate > 0.85 ? '#95e6cb' : rate > 0.7 ? '#ffb454' : '#f07178';
          return (
            <div key={gate} className="flex items-center">
              <div
                className="px-4 py-2 text-[10px] uppercase font-bold rounded-none border"
                style={{ color, borderColor: color + '40', background: color + '08' }}
              >
                {gate}
              </div>
              {i < GATE_PIPELINE.length - 1 && (
                <span className="text-[#6c7680] px-2 text-xs">{'\u2192'}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Overall Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="px-4 py-3 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
          <div className="text-2xl font-bold text-cyan-400">{stats.totalRuns}</div>
          <div className="text-[9px] text-[#6c7680] mt-0.5">Total Gate Runs</div>
        </div>
        <div className="px-4 py-3 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
          <div className={`text-2xl font-bold ${stats.passRate > 0.8 ? 'text-emerald-400' : 'text-amber-400'}`}>
            {pct(stats.passRate)}
          </div>
          <div className="text-[9px] text-[#6c7680] mt-0.5">Overall Pass Rate</div>
        </div>
        <div className="px-4 py-3 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
          <div className="text-2xl font-bold text-purple-400">{ms(stats.avgDuration)}</div>
          <div className="text-[9px] text-[#6c7680] mt-0.5">Avg Duration</div>
        </div>
      </div>

      {/* Recent Reports */}
      <div>
        <SectionHeader title="Recent Gate Runs" count={reports.length} />
        <div className="space-y-1">
          {reports.map(report => {
            const expanded = expandedReport === report.id;
            return (
              <div key={report.id}>
                <button
                  onClick={() => setExpandedReport(expanded ? null : report.id)}
                  className="w-full text-left px-3 py-2 rounded-none border transition-all"
                  style={{
                    background: '#0d1117',
                    borderColor: report.passed ? '#95e6cb20' : '#f0717820',
                  }}
                >
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-bold ${report.passed ? 'text-emerald-400' : 'text-red-400'}`}>
                      {report.passed ? '\u2713 PASS' : '\u2717 FAIL'}
                    </span>
                    <span className="text-[10px] text-[#e6e1cf]">{report.branch || report.beadId || report.id}</span>
                    <span className="text-[9px] text-[#6c7680]">
                      {report.stacks?.join(', ')}
                    </span>
                    <span className="text-[8px] text-[#6c7680] ml-auto">
                      {report.durationMs ? ms(report.durationMs) : ''} {'\u00B7'} {ago(report.createdAt)}
                    </span>
                    <span className="text-[10px] text-[#6c7680]">{expanded ? '\u25B4' : '\u25BE'}</span>
                  </div>
                </button>

                <AnimatePresence>
                  {expanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 py-3 border-x border-b space-y-2" style={{ background: '#0d111790', borderColor: '#2d363f' }}>
                        {report.gateResults.map(gr => (
                          <div key={gr.gate} className="flex items-start gap-3">
                            <span className={`text-[10px] w-4 ${gr.passed ? 'text-emerald-400' : 'text-red-400'}`}>
                              {gr.passed ? '\u2713' : '\u2717'}
                            </span>
                            <span className="text-[10px] text-[#e6e1cf] w-20 uppercase">{gr.gate}</span>
                            <span className="text-[9px] text-[#6c7680] flex-1 truncate">{gr.output}</span>
                            <span className="text-[8px] text-[#6c7680]">{ms(gr.durationMs)}</span>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Review Tab
// ═══════════════════════════════════════════════════════════════════════════

function ReviewTab({
  reviews,
  agents,
}: {
  reviews: ReviewEntry[];
  agents: ReviewAgent[];
}) {
  const reviewStats = useMemo(() => {
    const total = reviews.length;
    const passed = reviews.filter(r => r.passed).length;
    const totalFindings = reviews.reduce((s, r) => s + r.totalFindings, 0);
    const totalCritical = reviews.reduce((s, r) => s + r.criticalCount, 0);
    const totalAutoFix = reviews.reduce((s, r) => s + r.autoFixCount, 0);
    return { total, passed, totalFindings, totalCritical, totalAutoFix };
  }, [reviews]);

  const SEVERITY_COLORS: Record<string, string> = {
    critical: 'text-red-400',
    warning: 'text-amber-400',
    info: 'text-cyan-400',
  };

  return (
    <div className="space-y-4">
      {/* Review Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { label: 'Total Reviews', value: reviewStats.total, color: 'text-cyan-400' },
          { label: 'Passed', value: reviewStats.passed, color: 'text-emerald-400' },
          { label: 'Total Findings', value: reviewStats.totalFindings, color: 'text-amber-400' },
          { label: 'Critical', value: reviewStats.totalCritical, color: 'text-red-400' },
          { label: 'Auto-Fixed', value: reviewStats.totalAutoFix, color: 'text-purple-400' },
        ].map(s => (
          <div key={s.label} className="px-4 py-3 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-[9px] text-[#6c7680] mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Review Agents */}
        <div>
          <SectionHeader title="Review Agents" count={agents.length} />
          <div className="space-y-1">
            {agents.map(agent => (
              <div key={agent.id} className="px-3 py-2 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] text-[#e6e1cf] font-bold">{agent.name}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-none ${SEVERITY_COLORS[agent.severity] || 'text-zinc-400'}`}
                    style={{ background: '#1a1f26' }}>
                    {agent.severity.toUpperCase()}
                  </span>
                </div>
                <div className="text-[9px] text-[#6c7680]">{agent.focus}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Reviews */}
        <div className="lg:col-span-2">
          <SectionHeader title="Recent Reviews" count={reviews.length} />
          <div className="space-y-1">
            {reviews.map(rv => (
              <div key={rv.id} className="px-3 py-2 rounded-none border" style={{
                background: '#0d1117',
                borderColor: rv.passed ? '#95e6cb20' : '#f0717820',
              }}>
                <div className="flex items-center gap-3 mb-1.5">
                  <span className={`text-xs font-bold ${rv.passed ? 'text-emerald-400' : 'text-red-400'}`}>
                    {rv.passed ? '\u2713 PASS' : '\u2717 FAIL'}
                  </span>
                  <span className="text-[10px] text-[#e6e1cf]">{rv.beadId || rv.id}</span>
                  <span className="text-[8px] text-[#6c7680] ml-auto">{ago(rv.createdAt)}</span>
                </div>
                <div className="flex items-center gap-3 text-[9px]">
                  <span className="text-[#6c7680]">
                    <span className="text-amber-400">{rv.totalFindings}</span> findings
                  </span>
                  {rv.criticalCount > 0 && (
                    <span className="text-red-400">{rv.criticalCount} critical</span>
                  )}
                  {rv.autoFixCount > 0 && (
                    <span className="text-purple-400">{rv.autoFixCount} auto-fixed</span>
                  )}
                  <span className="text-[#6c7680]">{'\u00B7'}</span>
                  <span className="text-[#6c7680]">
                    {rv.agents.map((a, i) => (
                      <span key={a}>
                        {i > 0 && ', '}
                        <span className="text-[#95e6cb]">{a}</span>
                      </span>
                    ))}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Patterns Tab
// ═══════════════════════════════════════════════════════════════════════════

function PatternsTab({
  patterns,
  stats,
  categoryBreakdown,
}: {
  patterns: ErrorPattern[];
  stats: PatternStatsData;
  categoryBreakdown: [string, number][];
}) {
  return (
    <div className="space-y-4">
      {/* Pattern Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Total Patterns', value: stats.totalPatterns, color: 'text-cyan-400' },
          { label: 'Active', value: stats.activePatterns, color: 'text-amber-400' },
          { label: 'Resolved', value: stats.resolvedPatterns, color: 'text-emerald-400' },
          { label: 'Categories', value: categoryBreakdown.length, color: 'text-purple-400' },
        ].map(s => (
          <div key={s.label} className="px-4 py-3 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-[9px] text-[#6c7680] mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Category Distribution */}
        <div>
          <SectionHeader title="Category Distribution" count={categoryBreakdown.length} />
          <div className="space-y-1">
            {categoryBreakdown.map(([cat, count]) => {
              const maxCount = categoryBreakdown[0]?.[1] || 1;
              const widthPct = (count / maxCount) * 100;
              const catColors: Record<string, string> = {
                type_error: '#f07178',
                lint_error: '#ffb454',
                timeout: '#d2a6ff',
                import_error: '#95e6cb',
                network_error: '#ff8f40',
                syntax_error: '#f07178',
              };
              const barColor = catColors[cat] || '#6c7680';
              return (
                <div key={cat} className="flex items-center gap-2 px-3 py-1.5 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
                  <span className="text-[10px] w-24 truncate" style={{ color: barColor }}>{cat.replace(/_/g, ' ')}</span>
                  <div className="flex-1 h-2 rounded-none" style={{ background: '#1a1f26' }}>
                    <div
                      className="h-full rounded-none transition-all"
                      style={{ width: `${widthPct}%`, background: barColor + '60' }}
                    />
                  </div>
                  <span className="text-[10px] text-[#e6e1cf] w-8 text-right">{count}</span>
                </div>
              );
            })}
          </div>

          {/* Top Recurring */}
          {stats.topPatterns && stats.topPatterns.length > 0 && (
            <div className="mt-4">
              <SectionHeader title="Top Recurring" count={stats.topPatterns.length} />
              <div className="space-y-1">
                {stats.topPatterns.map((tp, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
                    <span className="text-[10px] text-red-400 font-bold w-6">{tp.count}x</span>
                    <span className="text-[9px] text-[#e6e1cf] truncate">{tp.signature}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* All Patterns List */}
        <div className="lg:col-span-2">
          <SectionHeader title="Error Patterns" count={patterns.length} />
          <div className="space-y-1 max-h-[600px] overflow-y-auto">
            {patterns.map(pat => (
              <div key={pat.id} className="px-3 py-2 rounded-none border" style={{ background: '#0d1117', borderColor: '#2d363f' }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] text-red-400 font-bold">{pat.count}x</span>
                  <span className="text-[10px] text-[#e6e1cf] font-mono truncate flex-1">{pat.signature}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded-none" style={{
                    background: pat.resolution ? '#95e6cb10' : '#f0717810',
                    color: pat.resolution ? '#95e6cb' : '#f07178',
                  }}>
                    {pat.resolution ? 'RESOLVED' : 'ACTIVE'}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[9px] text-[#6c7680]">
                  <span className="px-1 rounded-none" style={{ background: '#1a1f26' }}>{pat.category.replace(/_/g, ' ')}</span>
                  <span>{'\u00B7'}</span>
                  <span>First: {ago(pat.firstSeen)}</span>
                  <span>{'\u00B7'}</span>
                  <span>Last: {ago(pat.lastSeen)}</span>
                  {pat.beadIds.length > 0 && (
                    <>
                      <span>{'\u00B7'}</span>
                      <span>{pat.beadIds.length} beads</span>
                    </>
                  )}
                </div>
                {pat.resolution && (
                  <div className="text-[9px] text-[#95e6cb] mt-1">
                    {'\u2192'} {pat.resolution}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared Components
// ═══════════════════════════════════════════════════════════════════════════

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <h3 className="text-[11px] text-[#6c7680] uppercase tracking-wider">{title}</h3>
      {count !== undefined && (
        <span className="text-[9px] text-[#6c7680] px-1.5 py-0.5 rounded-none" style={{ background: '#1a1f26' }}>
          {count}
        </span>
      )}
    </div>
  );
}

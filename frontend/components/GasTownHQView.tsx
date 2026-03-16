'use client';

/**
 * GasTownHQView — Unified Gas Town Control Center
 *
 * Faithful recreation of Steve Yegge's Gas Town dashboard:
 * Single page with collapsible panels, SSE-style live updates,
 * summary banner, activity timeline, and all MEOW subsystems.
 *
 * Original reference: github.com/steveyegge/gastown
 * Aesthetic: Ayu Dark (#0f1419 bg, #1a1f26 cards, monospace, color-coded badges)
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Color Palette (matches original Gas Town CSS vars) ──────────────────────

const C = {
  bgDark: '#0f1419',
  bgCard: '#1a1f26',
  bgCardHover: '#242b33',
  textPrimary: '#e6e1cf',
  textSecondary: '#6c7680',
  textMuted: '#4a5159',
  border: '#2d363f',
  green: '#c2d94c',
  yellow: '#ffb454',
  red: '#f07178',
  blue: '#59c2ff',
  purple: '#d2a6ff',
  cyan: '#95e6cb',
  orange: '#ff8f40',
} as const;

// ─── Types (matching original Gas Town data model) ───────────────────────────

interface ConvoyRow {
  id: string;
  title: string;
  status: string;
  workStatus: 'complete' | 'active' | 'stale' | 'stuck' | 'waiting';
  progress: string;
  completed: number;
  total: number;
  progressPct: number;
  readyBeads: number;
  inProgress: number;
  assignees: string[];
  lastActivity: string;
}

interface WorkerRow {
  name: string;
  rig: string;
  agentType: 'polecat' | 'refinery' | 'crew';
  issueId: string;
  issueTitle: string;
  workStatus: 'working' | 'stale' | 'stuck' | 'idle';
  lastActivity: string;
}

interface MailRow {
  id: string;
  from: string;
  to: string;
  subject: string;
  age: string;
  priority: string;
  read: boolean;
}

interface DogRow {
  name: string;
  state: 'idle' | 'working';
  work: string;
  lastActive: string;
  rigCount: number;
}

interface EscalationRow {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  escalatedBy: string;
  age: string;
  acked: boolean;
}

interface IssueRow {
  id: string;
  title: string;
  type: string;
  priority: number;
  age: string;
  labels: string;
  assignee: string;
}

interface HookRow {
  id: string;
  title: string;
  agent: string;
  age: string;
  isStale: boolean;
}

interface SessionRow {
  name: string;
  role: string;
  rig: string;
  worker: string;
  activity: string;
}

interface MergeQueueRow {
  number: number;
  repo: string;
  title: string;
  ciStatus: 'pass' | 'fail' | 'pending';
  mergeable: 'ready' | 'conflict' | 'pending';
}

interface ActivityRow {
  time: string;
  icon: string;
  type: string;
  category: 'agent' | 'work' | 'comms' | 'system';
  actor: string;
  rig: string;
  summary: string;
}

interface HealthData {
  deaconHeartbeat: string;
  heartbeatFresh: boolean;
  healthyAgents: number;
  unhealthyAgents: number;
  isPaused: boolean;
}

interface MayorStatus {
  isAttached: boolean;
  lastActivity: string;
  isActive: boolean;
  runtime: string;
}

interface DashboardSummary {
  polecatCount: number;
  hookCount: number;
  issueCount: number;
  convoyCount: number;
  escalationCount: number;
  stuckPolecats: number;
  staleHooks: number;
  unackedEscalations: number;
  deadSessions: number;
  highPriorityIssues: number;
  hasAlerts: boolean;
}

// ─── Fallback Demo Data ──────────────────────────────────────────────────────

const DEMO_MAYOR: MayorStatus = {
  isAttached: true, lastActivity: '2m ago', isActive: true, runtime: 'claude',
};

const DEMO_HEALTH: HealthData = {
  deaconHeartbeat: '45s ago', heartbeatFresh: true,
  healthyAgents: 5, unhealthyAgents: 0, isPaused: false,
};

const DEMO_CONVOYS: ConvoyRow[] = [
  { id: 'gt-c1', title: 'Wave 6 Observability', status: 'open', workStatus: 'active', progress: '3/5', completed: 3, total: 5, progressPct: 60, readyBeads: 1, inProgress: 1, assignees: ['nux', 'dag'], lastActivity: '1m ago' },
  { id: 'gt-c2', title: 'FrankFlow Hooks', status: 'open', workStatus: 'active', progress: '2/4', completed: 2, total: 4, progressPct: 50, readyBeads: 0, inProgress: 2, assignees: ['toast'], lastActivity: '3m ago' },
  { id: 'gt-c3', title: 'Workspace Governance', status: 'open', workStatus: 'waiting', progress: '0/3', completed: 0, total: 3, progressPct: 0, readyBeads: 3, inProgress: 0, assignees: [], lastActivity: '—' },
];

const DEMO_WORKERS: WorkerRow[] = [
  { name: 'nux', rig: 'frontend', agentType: 'polecat', issueId: 'gt-1kp', issueTitle: 'Observability Tower Charts', workStatus: 'working', lastActivity: '30s ago' },
  { name: 'dag', rig: 'frontend', agentType: 'polecat', issueId: 'gt-1kq', issueTitle: 'Health Score Engine', workStatus: 'working', lastActivity: '1m ago' },
  { name: 'toast', rig: 'backend', agentType: 'polecat', issueId: 'gt-2ab', issueTitle: 'FrankFlow Hook Pattern', workStatus: 'stale', lastActivity: '8m ago' },
  { name: 'refinery', rig: 'frontend', agentType: 'refinery', issueId: '', issueTitle: '', workStatus: 'idle', lastActivity: '5m ago' },
  { name: 'witness', rig: 'frontend', agentType: 'crew', issueId: '', issueTitle: '', workStatus: 'idle', lastActivity: '12m ago' },
];

const DEMO_SESSIONS: SessionRow[] = [
  { name: 'gt-frontend-nux', role: 'polecat', rig: 'frontend', worker: 'nux', activity: '30s ago' },
  { name: 'gt-frontend-dag', role: 'polecat', rig: 'frontend', worker: 'dag', activity: '1m ago' },
  { name: 'gt-backend-toast', role: 'polecat', rig: 'backend', worker: 'toast', activity: '8m ago' },
  { name: 'gt-frontend-witness', role: 'witness', rig: 'frontend', worker: '', activity: '12m ago' },
  { name: 'gt-frontend-refinery', role: 'refinery', rig: 'frontend', worker: '', activity: '5m ago' },
];

const DEMO_ACTIVITY: ActivityRow[] = [
  { time: '30s ago', icon: '🔨', type: 'progress', category: 'work', actor: 'nux', rig: 'frontend', summary: 'Committed ObservabilityTower null-safety fixes' },
  { time: '1m ago', icon: '🔨', type: 'progress', category: 'work', actor: 'dag', rig: 'frontend', summary: 'Health score calculation engine wired' },
  { time: '3m ago', icon: '✉️', type: 'mail', category: 'comms', actor: 'toast', rig: 'backend', summary: 'Sent status update to Mayor' },
  { time: '5m ago', icon: '🔀', type: 'merge', category: 'work', actor: 'refinery', rig: 'frontend', summary: 'Merged feat/gas-town-null-safety → main' },
  { time: '8m ago', icon: '⚠️', type: 'stale', category: 'system', actor: 'toast', rig: 'backend', summary: 'No activity detected — may be stuck' },
  { time: '12m ago', icon: '📋', type: 'sling', category: 'work', actor: 'mayor', rig: '', summary: 'Slung gt-1kr: Convoy Tracker progress bars' },
  { time: '20m ago', icon: '🦨', type: 'session_start', category: 'agent', actor: 'nux', rig: 'frontend', summary: 'Session started for gt-1kp' },
  { time: '25m ago', icon: '✅', type: 'done', category: 'work', actor: 'dag', rig: 'frontend', summary: 'Completed gt-1kn: BeadsView velocity fix' },
];

const DEMO_MAIL: MailRow[] = [
  { id: 'msg-1', from: 'frontend/polecats/nux', to: 'mayor/', subject: 'Null-safety audit complete — 14 fixes applied', age: '2m ago', priority: 'normal', read: false },
  { id: 'msg-2', from: 'backend/polecats/toast', to: 'mayor/', subject: 'FrankFlow pattern learner blocked on type resolution', age: '8m ago', priority: 'high', read: false },
  { id: 'msg-3', from: 'mayor/', to: 'frontend/polecats/dag', subject: 'Priority: finish health score before convoy tracker', age: '15m ago', priority: 'normal', read: true },
];

const DEMO_MERGE_QUEUE: MergeQueueRow[] = [
  { number: 42, repo: 'frontend', title: 'feat: Gas Town null-safety fixes', ciStatus: 'pass', mergeable: 'ready' },
  { number: 15, repo: 'backend', title: 'feat: FrankFlow hook pattern learner', ciStatus: 'pending', mergeable: 'pending' },
];

const DEMO_DOGS: DogRow[] = [
  { name: 'alpha', state: 'working', work: 'Compacting old sessions', lastActive: '1m ago', rigCount: 2 },
  { name: 'beta', state: 'idle', work: '', lastActive: '10m ago', rigCount: 0 },
];

const DEMO_ESCALATIONS: EscalationRow[] = [
  { id: 'esc-1', title: 'toast stuck > 8 minutes on FrankFlow', severity: 'medium', escalatedBy: 'stuck-agent-dog', age: '3m ago', acked: false },
];

const DEMO_ISSUES: IssueRow[] = [
  { id: 'gt-1kp', title: 'Observability Tower Charts', type: 'feature', priority: 2, age: '1h', labels: 'wave-6', assignee: 'nux' },
  { id: 'gt-1kq', title: 'Health Score Engine', type: 'feature', priority: 2, age: '1h', labels: 'wave-6', assignee: 'dag' },
  { id: 'gt-2ab', title: 'FrankFlow Hook Pattern', type: 'feature', priority: 3, age: '2h', labels: 'frankflow', assignee: 'toast' },
  { id: 'gt-1kr', title: 'Convoy Tracker progress bars', type: 'feature', priority: 3, age: '45m', labels: 'wave-6', assignee: '' },
  { id: 'gt-1ks', title: 'Worker pool heat map', type: 'feature', priority: 4, age: '30m', labels: 'wave-6', assignee: '' },
];

const DEMO_HOOKS: HookRow[] = [
  { id: 'gt-1kp', title: 'Observability Tower Charts', agent: 'frontend/polecats/nux', age: '20m', isStale: false },
  { id: 'gt-1kq', title: 'Health Score Engine', agent: 'frontend/polecats/dag', age: '18m', isStale: false },
  { id: 'gt-2ab', title: 'FrankFlow Hook Pattern', agent: 'backend/polecats/toast', age: '45m', isStale: false },
];

// ─── New Panel Demo Data ──────────────────────────────────────────────────

const DEMO_GUZZOLINE = {
  level: 72, capacity: 100, burnRate: 8.5, fillRate: 12.0,
  hoursRemaining: 999, fuelStatus: 'NORMAL' as const,
  breakdown: { beadsReady: 15, polecatSlots: 3, budgetRemaining: 35.50, apiQuota: 68, mergeQueueSpace: 85 },
  generators: [
    { name: 'Issue Backlog', type: 'bead_creation', rate: 5 },
    { name: 'Daily Budget', type: 'budget_topup', rate: 2 },
    { name: 'Polecat Recycling', type: 'slot_release', rate: 8 },
    { name: 'API Quota Reset', type: 'quota_reset', rate: 1 },
  ],
  consumers: [
    { name: 'Polecat Work', type: 'polecat_work', rate: 6 },
    { name: 'LLM API Calls', type: 'api_calls', rate: 4 },
    { name: 'Merge Operations', type: 'merge_ops', rate: 2 },
    { name: 'Patrol Cycles', type: 'patrol_runs', rate: 1 },
  ],
  history: Array.from({ length: 24 }, (_, i) => ({
    hour: `${String(i).padStart(2, '0')}:00`,
    level: Math.max(20, Math.min(95, 72 + Math.sin(i * 0.5) * 20 + (Math.random() - 0.5) * 10)),
  })),
};

const DEMO_NDI = {
  agentId: 'ag-gastown-01', beadId: 'bead-1kp', moleculeId: 'mol-abc',
  overallStatus: 'healthy' as const,
  idempotent: true,
  pillars: [
    { name: 'agent_bead', status: 'intact' as const, location: 'meow_workers', recoveryMethod: 'Query meow_workers table' },
    { name: 'hook_bead', status: 'intact' as const, location: 'meow_hooks', recoveryMethod: 'Query meow_hooks + gt seance' },
    { name: 'molecule_chain', status: 'intact' as const, location: 'meow_molecules', recoveryMethod: 'Re-cook from ICE9 source' },
  ],
};

const DEMO_BOND_OPS = [
  { operator: 'cook', operandA: 'Formula (ICE9)', operandB: 'Variables', result: 'Proto (SOLID)', phase: 'ice9 → solid' },
  { operator: 'pour', operandA: 'Proto (SOLID)', operandB: 'Context', result: 'Molecule (LIQUID)', phase: 'solid → liquid' },
  { operator: 'wisp', operandA: 'Proto (SOLID)', operandB: 'TTL Config', result: 'Wisp (VAPOR)', phase: 'solid → vapor' },
  { operator: 'squash', operandA: 'Molecule (LIQUID)', operandB: 'Digest', result: 'Condensed (LIQUID)', phase: 'liquid → liquid' },
  { operator: 'burn', operandA: 'Wisp (VAPOR)', operandB: 'TTL Expiry', result: 'Artifacts Only', phase: 'vapor → ∅' },
  { operator: 'compound', operandA: 'Formula A', operandB: 'Formula B', result: 'Compound Formula', phase: 'ice9 → ice9' },
  { operator: 'synthesize', operandA: 'Results[]', operandB: 'Template', result: 'Convoy Artifact', phase: 'liquid → artifact' },
];

const DEMO_PLUGINS = [
  { id: 'ext-town-1', name: 'health-monitor', level: 'town' as const, status: 'enabled' as const, runs: 142, gates: 0 },
  { id: 'ext-town-2', name: 'cost-tracker', level: 'town' as const, status: 'enabled' as const, runs: 89, gates: 0 },
  { id: 'ext-town-3', name: 'mail-router', level: 'town' as const, status: 'enabled' as const, runs: 67, gates: 0 },
  { id: 'ext-rig-1', name: 'eslint-guard', level: 'rig' as const, status: 'enabled' as const, runs: 234, gates: 0 },
  { id: 'ext-rig-2', name: 'typecheck-guard', level: 'rig' as const, status: 'enabled' as const, runs: 198, gates: 0 },
  { id: 'ext-rig-3', name: 'test-runner', level: 'rig' as const, status: 'enabled' as const, runs: 156, gates: 0 },
  { id: 'ext-ref-1', name: 'code-review', level: 'refinery' as const, status: 'enabled' as const, runs: 45, gates: 3 },
  { id: 'ext-ref-2', name: 'security-scanner', level: 'refinery' as const, status: 'enabled' as const, runs: 45, gates: 2 },
  { id: 'ext-ref-3', name: 'changelog-gen', level: 'refinery' as const, status: 'enabled' as const, runs: 30, gates: 0 },
];

const DEMO_MALL = [
  { name: 'mol-polecat-work', version: '1.0.0', category: 'workflow', rating: 4.8, installs: 24, steps: 5, description: 'Standard polecat execution lifecycle' },
  { name: 'mol-patrol-deacon', version: '1.0.0', category: 'patrol', rating: 4.5, installs: 18, steps: 26, description: '26-step health patrol: heartbeat, budget, agent health, queue depth' },
  { name: 'mol-patrol-witness', version: '1.0.0', category: 'patrol', rating: 4.6, installs: 15, steps: 10, description: 'Code quality witness patrol: reviews, test coverage, style' },
  { name: 'mol-beads-release', version: '1.0.0', category: 'release', rating: 4.9, installs: 12, steps: 20, description: '20-step CHROME Enterprise release pipeline' },
  { name: 'mol-compound-convoy', version: '1.0.0', category: 'workflow', rating: 4.3, installs: 8, steps: 3, description: 'Multi-formula convoy orchestration' },
];

const DEMO_COMPOUNDS = [
  { id: 'cf-full-release', name: 'Full Release Pipeline', strategy: 'sequential', subs: ['mol-polecat-work', 'mol-patrol-witness', 'mol-beads-release'] },
  { id: 'cf-multi-rig', name: 'Multi-Rig Deploy', strategy: 'fan-out', subs: ['mol-polecat-work (frontend)', 'mol-polecat-work (backend)', 'mol-beads-release'] },
  { id: 'cf-patrol-suite', name: 'Full Patrol Suite', strategy: 'parallel', subs: ['mol-patrol-deacon', 'mol-patrol-witness', 'mol-patrol-refinery'] },
];

const DEMO_POLECAT_LEASE = [
  { state: 'RUN', label: 'Executing', description: 'Active coding, commits, tests', color: '#c2d94c' },
  { state: 'VERIFYING', label: 'CI Checking', description: 'Waiting for CI pipeline results', color: '#59c2ff' },
  { state: 'MANUAL_REQUESTED', label: 'Human Review', description: 'Needs human approval to proceed', color: '#ffb454' },
  { state: 'STUCK', label: 'Stuck/Dead', description: 'Agent has stopped responding, needs seance or reboot', color: '#f07178' },
];

const DEMO_BEADS_PIPELINE = [
  'Branch Created', 'Checklist Populated', 'Code Written', 'Self-Review Done',
  'Tests Written', 'Tests Pass', 'Lint Clean', 'Type-Check Pass',
  'Coverage Met', 'Security Scan', 'PR Created', 'Review Requested',
  'Changes Applied', 'CI Green', 'Approval Received', 'Rebase Clean',
  'Merge Executed', 'Deploy Verified', 'Changelog Updated', 'Bead Closed',
];

const DEMO_SEANCE_LOG = [
  { id: 'seance-1', session: 'gt-frontend-nux-old', agent: 'nux', deathReason: 'timeout', beadsRecovered: 2, time: '14m ago' },
  { id: 'seance-2', session: 'gt-orch-toast-v2', agent: 'toast', deathReason: 'oom', beadsRecovered: 1, time: '1h ago' },
];

const DEMO_GT_CLI_HISTORY = [
  { cmd: 'status --full', result: 'OK', time: '1m ago' },
  { cmd: 'sling bead-1kp gastown/polecats/nux', result: 'Hook created', time: '3m ago' },
  { cmd: 'guzzoline reservoir', result: '72/100 NORMAL', time: '5m ago' },
  { cmd: 'mall browse --category patrol', result: '3 formulas', time: '8m ago' },
  { cmd: 'convoy list', result: '3 convoys', time: '12m ago' },
  { cmd: 'nudge all "Status check"', result: 'Delivered', time: '15m ago' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeSummary(workers: WorkerRow[], hooks: HookRow[], issues: IssueRow[], convoys: ConvoyRow[], escalations: EscalationRow[]): DashboardSummary {
  const stuckPolecats = workers.filter(w => w.workStatus === 'stuck').length;
  const staleHooks = hooks.filter(h => h.isStale).length;
  const unacked = escalations.filter(e => !e.acked).length;
  const highPri = issues.filter(i => i.priority <= 2).length;
  return {
    polecatCount: workers.length,
    hookCount: hooks.length,
    issueCount: issues.length,
    convoyCount: convoys.length,
    escalationCount: escalations.length,
    stuckPolecats,
    staleHooks,
    unackedEscalations: unacked,
    deadSessions: 0,
    highPriorityIssues: highPri,
    hasAlerts: stuckPolecats > 0 || staleHooks > 0 || unacked > 0 || highPri > 0,
  };
}

const navigate = (viewId: string) => {
  const url = new URL(window.location.href);
  url.searchParams.set('view', viewId);
  window.history.pushState({ view: viewId }, '', url.toString());
  window.dispatchEvent(new PopStateEvent('popstate', { state: { view: viewId } }));
};

// ─── Badge Component ─────────────────────────────────────────────────────────

function Badge({ color, children }: { color: 'green' | 'yellow' | 'red' | 'blue' | 'purple' | 'cyan' | 'orange' | 'muted'; children: React.ReactNode }) {
  const map: Record<string, string> = {
    green: `bg-[${C.green}] text-[${C.bgDark}]`,
    yellow: `bg-[${C.yellow}] text-[${C.bgDark}]`,
    red: `bg-[${C.red}] text-[${C.bgDark}]`,
    blue: `bg-[${C.blue}] text-[${C.bgDark}]`,
    purple: `bg-[${C.purple}] text-[${C.bgDark}]`,
    cyan: `bg-[${C.cyan}] text-[${C.bgDark}]`,
    orange: `bg-[${C.orange}] text-[${C.bgDark}]`,
    muted: 'bg-[#3d4752] text-[#6c7680]',
  };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${map[color] || map.muted}`} style={color !== 'muted' ? { background: C[color as keyof typeof C] || undefined, color: C.bgDark } : undefined}>
      {children}
    </span>
  );
}

// ─── Activity Dot ────────────────────────────────────────────────────────────

function ActivityDot({ status }: { status: string }) {
  const color = status === 'working' ? C.green : status === 'stale' ? C.yellow : status === 'stuck' ? C.red : C.textMuted;
  return <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: color, boxShadow: status !== 'idle' ? `0 0 6px ${color}` : 'none' }} />;
}

// ─── Progress Bar ────────────────────────────────────────────────────────────

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="w-16 h-1 rounded overflow-hidden" style={{ background: C.border }}>
      <div className="h-full rounded transition-all duration-300" style={{ width: `${pct}%`, background: C.green }} />
    </div>
  );
}

// ─── Collapsible Panel ───────────────────────────────────────────────────────

function Panel({ title, count, children, defaultOpen = true, countAlert = false, description, showHelp = false }: {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
  countAlert?: boolean;
  description?: string;
  showHelp?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-md overflow-hidden" style={{ background: C.bgCard, border: `1px solid ${C.border}` }}>
      <div
        className="flex items-center justify-between px-3.5 py-2.5 cursor-pointer select-none"
        style={{ background: C.bgDark, borderBottom: (open || (showHelp && description)) ? `1px solid ${C.border}` : 'none' }}
        onClick={() => setOpen(!open)}
      >
        <h2 className="text-[13px] font-semibold" style={{ color: C.textPrimary }}>{title}</h2>
        <div className="flex items-center gap-2">
          <span
            className="text-[11px] px-2 py-0.5 rounded-full"
            style={{
              background: countAlert ? C.red : C.border,
              color: countAlert ? C.bgDark : C.textMuted,
              fontWeight: 600,
            }}
          >
            {count}
          </span>
          <span className="text-[11px]" style={{ color: C.textMuted }}>{open ? '▼' : '▶'}</span>
        </div>
      </div>
      {showHelp && description && (
        <div className="px-3.5 py-2" style={{ background: C.cyan + '06', borderBottom: open ? `1px solid ${C.border}` : 'none' }}>
          <p className="text-[11px] leading-relaxed m-0" style={{ color: C.cyan + 'cc' }}>{description}</p>
        </div>
      )}
      {open && (
        <div className="max-h-[280px] overflow-y-auto">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Table Wrapper ───────────────────────────────────────────────────────────

function TH({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-2.5 py-1.5 text-left text-[10px] uppercase tracking-wider font-medium sticky top-0" style={{ color: C.textMuted, background: C.bgCard, borderBottom: `1px solid ${C.border}` }}>
      {children}
    </th>
  );
}

function TD({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`px-2.5 py-1.5 text-[12px] ${className}`} style={{ borderBottom: `1px solid ${C.border}`, color: C.textPrimary }}>
      {children}
    </td>
  );
}

// ─── Work Status Badge ───────────────────────────────────────────────────────

function WorkStatusBadge({ status }: { status: string }) {
  const map: Record<string, 'green' | 'yellow' | 'red' | 'muted' | 'cyan'> = {
    complete: 'green', active: 'green', working: 'green',
    stale: 'yellow', stuck: 'red', idle: 'muted', waiting: 'muted',
  };
  const labels: Record<string, string> = {
    complete: '✓ Done', active: 'Active', working: 'Working',
    stale: 'Stale', stuck: 'Stuck', idle: 'Idle', waiting: 'Waiting',
  };
  return <Badge color={map[status] || 'muted'}>{labels[status] || status}</Badge>;
}

// ─── Main Dashboard ──────────────────────────────────────────────────────────

export default function GasTownHQView() {
  const [connected, setConnected] = useState(false);
  const [mayor, setMayor] = useState<MayorStatus>(DEMO_MAYOR);
  const [health, setHealth] = useState<HealthData>(DEMO_HEALTH);
  const [convoys, setConvoys] = useState<ConvoyRow[]>(DEMO_CONVOYS);
  const [workers, setWorkers] = useState<WorkerRow[]>(DEMO_WORKERS);
  const [sessions, setSessions] = useState<SessionRow[]>(DEMO_SESSIONS);
  const [activity, setActivity] = useState<ActivityRow[]>(DEMO_ACTIVITY);
  const [mail, setMail] = useState<MailRow[]>(DEMO_MAIL);
  const [mergeQueue, setMergeQueue] = useState<MergeQueueRow[]>(DEMO_MERGE_QUEUE);
  const [dogs, setDogs] = useState<DogRow[]>(DEMO_DOGS);
  const [escalations, setEscalations] = useState<EscalationRow[]>(DEMO_ESCALATIONS);
  const [issues, setIssues] = useState<IssueRow[]>(DEMO_ISSUES);
  const [hooks, setHooks] = useState<HookRow[]>(DEMO_HOOKS);
  const [activityFilter, setActivityFilter] = useState('all');
  const [pauseRefresh, setPauseRefresh] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [cliInput, setCliInput] = useState('');
  const [cliHistory, setCliHistory] = useState(DEMO_GT_CLI_HISTORY);
  const [cliLoading, setCliLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // ── Fetch all data in parallel ──────────────────────────────────────────

  const fetchAll = useCallback(async (signal: AbortSignal) => {
    try {
      const endpoints = [
        'town/pulse', 'molecules', 'convoys', 'feed',
        'observability/stats', 'workers', 'mail', 'sessions',
        'dogs', 'escalations', 'issues', 'hooks', 'merge-queue',
      ];
      const results = await Promise.allSettled(
        endpoints.map(ep => fetch(`${API}/api/meow/${ep}`, { signal }).then(r => r.ok ? r.json() : null))
      );
      const get = (i: number) => results[i]?.status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<unknown>).value : null;

      const pulse = get(0) as Record<string, unknown> | null;
      if (pulse) {
        setMayor(prev => ({ ...prev, ...((pulse.mayor as MayorStatus) || {}) }));
        setHealth(prev => ({ ...prev, ...((pulse.health as HealthData) || {}) }));
      }

      const molData = get(1);
      const conData = get(2);
      const feedData = get(3);
      const obsData = get(4);
      const wrkData = get(5);
      const mailData = get(6);
      const sessData = get(7);
      const dogData = get(8);
      const escData = get(9);
      const issData = get(10);
      const hookData = get(11);
      const mqData = get(12);

      if (Array.isArray(conData)) setConvoys(conData);
      else if (conData && Array.isArray((conData as Record<string, unknown>).convoys)) setConvoys((conData as Record<string, unknown>).convoys as ConvoyRow[]);

      if (Array.isArray(wrkData)) setWorkers(wrkData);
      else if (wrkData && Array.isArray((wrkData as Record<string, unknown>).workers)) setWorkers((wrkData as Record<string, unknown>).workers as WorkerRow[]);

      if (Array.isArray(feedData)) setActivity(feedData);
      else if (feedData && Array.isArray((feedData as Record<string, unknown>).events)) setActivity((feedData as Record<string, unknown>).events as ActivityRow[]);

      if (Array.isArray(mailData)) setMail(mailData);
      else if (mailData && Array.isArray((mailData as Record<string, unknown>).mail)) setMail((mailData as Record<string, unknown>).mail as MailRow[]);

      if (Array.isArray(sessData)) setSessions(sessData);
      if (Array.isArray(dogData)) setDogs(dogData);
      if (Array.isArray(escData)) setEscalations(escData);
      if (Array.isArray(mqData)) setMergeQueue(mqData);

      if (Array.isArray(issData)) setIssues(issData);
      else if (issData && Array.isArray((issData as Record<string, unknown>).issues)) setIssues((issData as Record<string, unknown>).issues as IssueRow[]);

      if (Array.isArray(hookData)) setHooks(hookData);
      else if (hookData && Array.isArray((hookData as Record<string, unknown>).hooks)) setHooks((hookData as Record<string, unknown>).hooks as HookRow[]);

      setConnected(true);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    fetchAll(ac.signal);
    if (pauseRefresh) return;
    const iv = setInterval(() => fetchAll(ac.signal), 6000);
    return () => { ac.abort(); clearInterval(iv); };
  }, [fetchAll, pauseRefresh]);

  // ── Computed ────────────────────────────────────────────────────────────

  const summary = useMemo(() => computeSummary(workers, hooks, issues, convoys, escalations), [workers, hooks, issues, convoys, escalations]);

  const filteredActivity = useMemo(() => {
    if (activityFilter === 'all') return activity;
    return activity.filter(a => a.category === activityFilter);
  }, [activity, activityFilter]);

  const unreadMail = useMemo(() => mail.filter(m => !m.read).length, [mail]);

  const handleCliSubmit = useCallback(async () => {
    if (!cliInput.trim() || cliLoading) return;
    setCliLoading(true);
    const cmd = cliInput.trim();
    setCliInput('');
    try {
      const res = await fetch(`${API}/api/meow/cli`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json();
      setCliHistory(prev => [{ cmd, result: data?.output?.slice(0, 60) ?? 'OK', time: 'now' }, ...prev].slice(0, 20));
    } catch {
      setCliHistory(prev => [{ cmd, result: '(offline — queued)', time: 'now' }, ...prev].slice(0, 20));
    }
    setCliLoading(false);
  }, [cliInput, cliLoading]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen font-mono text-[13px] leading-relaxed" style={{ background: C.bgDark, color: C.textPrimary }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-4 py-3 mb-4" style={{ borderBottom: `1px solid ${C.border}` }}>
        <pre className="text-[9px] leading-tight m-0 whitespace-pre select-none" style={{ color: C.cyan, textShadow: `0 0 10px ${C.cyan}` }}>
{`  ___   _   ___   _____ _____      ___  _     ___  ___  _  _ _____ ___  ___  _
 / __| /_\\ / __| |_   _/ _ \\ \\    / / \\| |   / __|/ _ \\| \\| |_   _| _ \\/ _ \\| |
| (_ |/ _ \\\\__ \\   | || (_) \\ \\/\\/ /| .  |  | (__| (_) | .  | | | |   / (_) | |__
 \\___/_/ \\_\\___/   |_| \\___/ \\_/\\_/ |_|\\_|   \\___|\\___/|_|\\_| |_| |_|_\\\\___/|____|`}
        </pre>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowHelp(h => !h)}
            className="text-[11px] px-2 py-1 rounded"
            style={{
              border: `1px solid ${showHelp ? C.cyan + '40' : C.border}`,
              color: showHelp ? C.cyan : C.textMuted,
              background: showHelp ? C.cyan + '10' : 'transparent',
            }}
            title="Mostrar/ocultar legendas explicativas"
          >
            {showHelp ? '? ON' : '?'}
          </button>
          <button
            onClick={() => setPauseRefresh(p => !p)}
            className="text-[11px] px-2 py-1 rounded"
            style={{
              border: `1px solid ${pauseRefresh ? C.border : C.green + '40'}`,
              color: pauseRefresh ? C.textMuted : C.green,
              background: pauseRefresh ? 'transparent' : C.green + '10',
            }}
          >
            {pauseRefresh ? '○ Paused' : '● Live'}
          </button>
          <span className="text-[11px]" style={{ color: connected ? C.green : C.red }}>
            {connected ? '● Connected' : '○ Offline'}
          </span>
        </div>
      </header>

      <div className="px-4 space-y-4 pb-8">
        {/* ── Help Legend ──────────────────────────────────────────── */}
        {showHelp && (
          <div className="rounded-md px-4 py-3 space-y-3" style={{ background: C.cyan + '08', border: `1px solid ${C.cyan}20` }}>
            <div>
              <h3 className="text-[13px] font-semibold m-0 mb-1" style={{ color: C.cyan }}>O que e Gas Town?</h3>
              <p className="text-[11px] leading-relaxed m-0" style={{ color: C.textSecondary }}>
                Um centro de controle para agentes de IA que programam codigo autonomamente.
                Cada &quot;funcionario&quot; e uma IA (Claude, Codex, etc.) que recebe tarefas, escreve codigo, faz commits e manda Pull Requests — tudo sozinha.
                O dashboard mostra tudo que esta acontecendo em tempo real.
              </p>
            </div>
            <div>
              <h3 className="text-[13px] font-semibold m-0 mb-1" style={{ color: C.cyan }}>Legenda de Cores</h3>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {[
                  { color: C.green, label: 'Verde = Ativo, funcionando, OK' },
                  { color: C.yellow, label: 'Amarelo = Atencao, stale, pendente' },
                  { color: C.red, label: 'Vermelho = Erro, travado, critico' },
                  { color: C.blue, label: 'Azul = IDs, links, referencias' },
                  { color: C.purple, label: 'Roxo = Agentes, responsaveis' },
                  { color: C.cyan, label: 'Ciano = Destaque, filtros, ajuda' },
                  { color: C.orange, label: 'Laranja = Alertas de sistema' },
                ].map(c => (
                  <div key={c.label} className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: c.color }} />
                    <span className="text-[10px]" style={{ color: C.textSecondary }}>{c.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-[13px] font-semibold m-0 mb-1" style={{ color: C.cyan }}>Status dos Agentes</h3>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {[
                  { dot: C.green, label: 'Working = Codando ativamente' },
                  { dot: C.yellow, label: 'Stale = Sem atividade recente (pode estar pensando ou travado)' },
                  { dot: C.red, label: 'Stuck = Definitivamente travado, precisa de intervencao' },
                  { dot: C.textMuted, label: 'Idle = Disponivel, sem tarefa' },
                ].map(s => (
                  <div key={s.label} className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: s.dot, boxShadow: s.dot !== C.textMuted ? `0 0 6px ${s.dot}` : 'none' }} />
                    <span className="text-[10px]" style={{ color: C.textSecondary }}>{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Mayor Banner ───────────────────────────────────────────── */}
        {showHelp && (
          <p className="text-[10px] m-0 px-1" style={{ color: C.cyan + 'aa' }}>
            O Mayor e o &quot;chefe&quot; da operacao — a IA principal que distribui tarefas, decide prioridades e recebe relatorios de todos os agentes.
          </p>
        )}
        <div
          className="flex items-center justify-between px-4 py-3 rounded-md"
          style={{
            background: mayor.isAttached ? C.green + '08' : C.red + '08',
            border: `1px solid ${mayor.isAttached ? C.green + '20' : C.red + '20'}`,
          }}
        >
          <div className="flex items-center gap-3">
            <span className="text-xl">🎩</span>
            <span className="font-semibold text-[13px]">The Mayor</span>
            {mayor.isAttached
              ? <Badge color="green">Attached</Badge>
              : <Badge color="muted">Detached</Badge>
            }
          </div>
          {mayor.isAttached && (
            <div className="flex items-center gap-6 text-[11px]" style={{ color: C.textSecondary }}>
              <span>Activity: <span style={{ color: mayor.isActive ? C.green : C.textMuted }}>{mayor.lastActivity}</span></span>
              <span>Runtime: <span style={{ color: C.cyan }}>{mayor.runtime}</span></span>
            </div>
          )}
        </div>

        {/* ── Summary & Alerts Banner ────────────────────────────────── */}
        {showHelp && (
          <p className="text-[10px] m-0 px-1" style={{ color: C.cyan + 'aa' }}>
            Resumo rapido: heartbeat do sistema, contagem de agentes/tarefas/convoys, e alertas criticos no lado direito (agentes travados, hooks parados, escalacoes pendentes).
          </p>
        )}
        <div className="flex items-center justify-between px-4 py-2.5 rounded-md" style={{ background: C.bgCard, border: `1px solid ${C.border}` }}>
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-1.5">
              <span style={{ color: health.heartbeatFresh ? C.green : C.red }}>{health.heartbeatFresh ? '✓' : '⚠'}</span>
              <span className="text-[11px]" style={{ color: C.textSecondary }}>💓 {health.deaconHeartbeat}</span>
            </div>
            {[
              { icon: '🦨', val: summary.polecatCount, label: 'Polecats' },
              { icon: '🪝', val: summary.hookCount, label: 'Hooks' },
              { icon: '📋', val: summary.issueCount, label: 'Work' },
              { icon: '🚚', val: summary.convoyCount, label: 'Convoys' },
              { icon: '⚠️', val: summary.escalationCount, label: 'Escalations' },
            ].map(s => (
              <div key={s.label} className="flex items-center gap-1.5 text-[12px]">
                <span className="font-bold" style={{ color: C.textPrimary }}>{s.val}</span>
                <span style={{ color: C.textMuted }}>{s.icon} {s.label}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {summary.hasAlerts ? (
              <>
                {summary.stuckPolecats > 0 && <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: C.red + '20', color: C.red }}>💀 {summary.stuckPolecats} stuck</span>}
                {summary.staleHooks > 0 && <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: C.yellow + '20', color: C.yellow }}>⏰ {summary.staleHooks} stale</span>}
                {summary.unackedEscalations > 0 && <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: C.orange + '20', color: C.orange }}>🔔 {summary.unackedEscalations} unacked</span>}
                {summary.highPriorityIssues > 0 && <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: C.red + '20', color: C.red }}>🔥 {summary.highPriorityIssues} P1/P2</span>}
              </>
            ) : (
              <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: C.green + '20', color: C.green }}>✓ All clear</span>
            )}
          </div>
        </div>

        {/* ── Panels Grid ────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">

          {/* Convoys Panel */}
          <Panel title="🚚 Convoys" count={convoys.length} showHelp={showHelp}
            description="Grupos de tarefas relacionadas (como uma sprint). Cada convoy agrupa varias issues que formam uma entrega maior. A barra de progresso mostra quantas sub-tarefas ja foram concluidas."
          >
            {convoys.length === 0 ? (
              <div className="p-4 text-center text-[12px]" style={{ color: C.textMuted }}>No active convoys</div>
            ) : (
              <table className="w-full border-collapse">
                <thead><tr><TH>Status</TH><TH>Convoy</TH><TH>Progress</TH><TH>Work</TH><TH>Activity</TH></tr></thead>
                <tbody>
                  {convoys.map(c => (
                    <tr key={c.id} className="cursor-pointer" style={{ transition: 'background 0.15s' }} onMouseEnter={e => (e.currentTarget.style.background = C.bgCardHover)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <TD><WorkStatusBadge status={c.workStatus} /></TD>
                      <TD>
                        <span className="font-semibold" style={{ color: C.blue }}>{c.id}</span>
                        {c.title && <div className="text-[11px]" style={{ color: C.textSecondary }}>{c.title}</div>}
                        {c.assignees.length > 0 && (
                          <div className="flex gap-1 mt-0.5">{c.assignees.map(a => <span key={a} className="text-[10px] px-1 rounded" style={{ background: C.blue + '15', color: C.blue }}>{a}</span>)}</div>
                        )}
                      </TD>
                      <TD>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px]">{c.progress}</span>
                          <span className="text-[10px]" style={{ color: C.textMuted }}>{c.progressPct}%</span>
                        </div>
                        <ProgressBar pct={c.progressPct} />
                      </TD>
                      <TD>
                        <div className="flex flex-col gap-0.5">
                          {c.readyBeads > 0 && <span className="text-[10px] px-1 rounded inline-block" style={{ background: C.cyan + '15', color: C.cyan }}>{c.readyBeads} ready</span>}
                          {c.inProgress > 0 && <span className="text-[10px] px-1 rounded inline-block" style={{ background: C.yellow + '15', color: C.yellow }}>{c.inProgress} active</span>}
                          {c.workStatus === 'complete' && <span className="text-[10px] px-1 rounded inline-block" style={{ background: C.green + '15', color: C.green }}>all done</span>}
                        </div>
                      </TD>
                      <TD><ActivityDot status={c.workStatus} /><span className="text-[11px]" style={{ color: C.textSecondary }}>{c.lastActivity}</span></TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* Polecats Panel */}
          <Panel title="🦨 Polecats" count={workers.length} showHelp={showHelp}
            description="Agentes de IA que escrevem codigo. Cada polecat e uma sessao de IA (Claude, Codex) rodando num terminal. Verde = codando, Amarelo = parado, Vermelho = travado, Cinza = disponivel."
          >
            {workers.length === 0 ? (
              <div className="p-4 text-center text-[12px]" style={{ color: C.textMuted }}>No polecats</div>
            ) : (
              <table className="w-full border-collapse">
                <thead><tr><TH>Worker</TH><TH>Type</TH><TH>Rig</TH><TH>Working On</TH><TH>Status</TH><TH>Activity</TH></tr></thead>
                <tbody>
                  {workers.map(w => (
                    <tr key={w.name} onMouseEnter={e => (e.currentTarget.style.background = C.bgCardHover)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <TD><span className="font-semibold">{w.name}</span></TD>
                      <TD>{w.agentType === 'refinery' ? <Badge color="blue">refinery</Badge> : w.agentType === 'crew' ? <Badge color="purple">crew</Badge> : <Badge color="muted">polecat</Badge>}</TD>
                      <TD><span style={{ color: C.textSecondary }}>{w.rig}</span></TD>
                      <TD>
                        {w.issueId ? (
                          <><span style={{ color: C.textSecondary }}>{w.issueId}</span> <span className="text-[11px]" style={{ color: C.textPrimary }}>{w.issueTitle}</span></>
                        ) : <span style={{ color: C.textMuted }}>—</span>}
                      </TD>
                      <TD><WorkStatusBadge status={w.workStatus} /></TD>
                      <TD><ActivityDot status={w.workStatus} /><span className="text-[11px]" style={{ color: C.textSecondary }}>{w.lastActivity}</span></TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* Sessions Panel */}
          <Panel title="📟 Sessions" count={sessions.length} showHelp={showHelp}
            description="Terminais persistentes (tmux) onde cada agente roda. Polecat = trabalhador, Witness = observador de qualidade, Refinery = processador permanente que refina codigo."
          >
            {sessions.length === 0 ? (
              <div className="p-4 text-center text-[12px]" style={{ color: C.textMuted }}>No active sessions</div>
            ) : (
              <table className="w-full border-collapse">
                <thead><tr><TH>Role</TH><TH>Rig</TH><TH>Worker</TH><TH>Activity</TH></tr></thead>
                <tbody>
                  {sessions.map(s => (
                    <tr key={s.name} onMouseEnter={e => (e.currentTarget.style.background = C.bgCardHover)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <TD><span style={{ color: s.role === 'witness' ? C.purple : s.role === 'refinery' ? C.blue : C.textPrimary }}>{s.role}</span></TD>
                      <TD>{s.rig}</TD>
                      <TD>{s.worker || '—'}</TD>
                      <TD><span style={{ color: C.textSecondary }}>{s.activity}</span></TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* Activity Timeline Panel */}
          <Panel title="📜 Activity" count={activity.length} showHelp={showHelp}
            description="Log em tempo real de tudo que acontece. Filtre por categoria: agent (acoes de agentes), work (commits/merges), comms (mensagens), system (alertas). Cada bolinha colorida indica a categoria."
          >
            <div className="px-2.5 py-2 flex gap-1" style={{ borderBottom: `1px solid ${C.border}` }}>
              {['all', 'agent', 'work', 'comms', 'system'].map(cat => (
                <button
                  key={cat}
                  onClick={() => setActivityFilter(cat)}
                  className="text-[10px] uppercase px-2 py-0.5 rounded transition-colors"
                  style={{
                    background: activityFilter === cat ? C.cyan + '15' : 'transparent',
                    color: activityFilter === cat ? C.cyan : C.textMuted,
                    border: `1px solid ${activityFilter === cat ? C.cyan + '30' : 'transparent'}`,
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>
            {filteredActivity.length === 0 ? (
              <div className="p-4 text-center text-[12px]" style={{ color: C.textMuted }}>No events match filter</div>
            ) : (
              <div className="divide-y" style={{ borderColor: C.border }}>
                {filteredActivity.map((a, i) => (
                  <div key={i} className="px-3 py-2 flex items-start gap-2.5" style={{ borderBottom: `1px solid ${C.border}` }}>
                    <div className="flex flex-col items-center gap-1 w-14 flex-shrink-0">
                      <span className="text-[10px]" style={{ color: C.textMuted }}>{a.time}</span>
                      <span className="w-2 h-2 rounded-full" style={{ background: a.category === 'agent' ? C.blue : a.category === 'work' ? C.green : a.category === 'comms' ? C.purple : C.orange }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px]"><span className="mr-1.5">{a.icon}</span>{a.summary}</div>
                      <div className="flex gap-1.5 mt-1">
                        {a.actor && <span className="text-[10px] px-1 rounded" style={{ background: C.blue + '15', color: C.blue }}>{a.actor}</span>}
                        {a.rig && <span className="text-[10px] px-1 rounded" style={{ background: C.purple + '15', color: C.purple }}>{a.rig}</span>}
                        <span className="text-[10px] px-1 rounded" style={{ background: C.border, color: C.textMuted }}>{a.type}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* Mail Panel */}
          <Panel title="✉️ Mail" count={mail.length} countAlert={unreadMail > 0} showHelp={showHelp}
            description="Correio interno entre agentes. O Mayor manda ordens, polecats mandam relatorios. Negrito = nao lido. Badge vermelho no contador = mensagens pendentes. HIGH = urgente."
          >
            {mail.length === 0 ? (
              <div className="p-4 text-center text-[12px]" style={{ color: C.textMuted }}>No mail</div>
            ) : (
              <div>
                {mail.map(m => (
                  <div
                    key={m.id}
                    className="px-3 py-2.5 cursor-pointer transition-colors"
                    style={{ borderBottom: `1px solid ${C.border}`, background: m.read ? 'transparent' : C.blue + '05' }}
                    onMouseEnter={e => (e.currentTarget.style.background = C.bgCardHover)}
                    onMouseLeave={e => (e.currentTarget.style.background = m.read ? 'transparent' : C.blue + '05')}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold" style={{ color: m.read ? C.textSecondary : C.textPrimary }}>{m.subject}</span>
                      <span className="text-[10px]" style={{ color: C.textMuted }}>{m.age}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px]" style={{ color: C.cyan }}>{m.from}</span>
                      <span className="text-[10px]" style={{ color: C.textMuted }}>→</span>
                      <span className="text-[10px]" style={{ color: C.textMuted }}>{m.to}</span>
                      {m.priority === 'high' && <span className="text-[9px] px-1 rounded" style={{ background: C.red + '20', color: C.red }}>HIGH</span>}
                      {!m.read && <span className="w-1.5 h-1.5 rounded-full" style={{ background: C.blue }} />}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* Merge Queue Panel */}
          <Panel title="🔀 Merge Queue" count={mergeQueue.length} showHelp={showHelp}
            description="Pull Requests aguardando merge no codigo principal. CI = testes automaticos (verde = passou). Merge = se pode ser integrado (verde = pronto, vermelho = conflito)."
          >
            {mergeQueue.length === 0 ? (
              <div className="p-4 text-center text-[12px]" style={{ color: C.textMuted }}>No PRs in queue</div>
            ) : (
              <table className="w-full border-collapse">
                <thead><tr><TH>PR</TH><TH>Repo</TH><TH>Title</TH><TH>CI</TH><TH>Merge</TH></tr></thead>
                <tbody>
                  {mergeQueue.map(pr => (
                    <tr key={pr.number} onMouseEnter={e => (e.currentTarget.style.background = C.bgCardHover)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <TD><span className="font-semibold" style={{ color: C.blue }}>#{pr.number}</span></TD>
                      <TD>{pr.repo}</TD>
                      <TD><span className="text-[11px]">{pr.title}</span></TD>
                      <TD><Badge color={pr.ciStatus === 'pass' ? 'green' : pr.ciStatus === 'fail' ? 'red' : 'yellow'}>{pr.ciStatus}</Badge></TD>
                      <TD><Badge color={pr.mergeable === 'ready' ? 'green' : pr.mergeable === 'conflict' ? 'red' : 'yellow'}>{pr.mergeable}</Badge></TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* Dogs Panel */}
          <Panel title="🐕 Dogs" count={dogs.length} showHelp={showHelp}
            description="Workers de background que fazem manutencao automatica (nao codam). Compactam sessoes antigas, limpam branches, detectam agentes travados e escalam problemas."
          >
            {dogs.length === 0 ? (
              <div className="p-4 text-center text-[12px]" style={{ color: C.textMuted }}>No dogs running</div>
            ) : (
              <table className="w-full border-collapse">
                <thead><tr><TH>Name</TH><TH>State</TH><TH>Work</TH><TH>Activity</TH><TH>Rigs</TH></tr></thead>
                <tbody>
                  {dogs.map(d => (
                    <tr key={d.name} onMouseEnter={e => (e.currentTarget.style.background = C.bgCardHover)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <TD><span className="font-semibold">{d.name}</span></TD>
                      <TD><Badge color={d.state === 'working' ? 'green' : 'muted'}>{d.state}</Badge></TD>
                      <TD>{d.work || <span style={{ color: C.textMuted }}>—</span>}</TD>
                      <TD><span style={{ color: C.textSecondary }}>{d.lastActive}</span></TD>
                      <TD>{d.rigCount}</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* Escalations Panel */}
          <Panel title="⚠️ Escalations" count={escalations.length} countAlert={escalations.some(e => !e.acked)} showHelp={showHelp}
            description="Problemas que precisam de atencao humana. Quando algo da errado e o sistema nao resolve sozinho, gera uma escalacao. Acked = alguem ja reconheceu o problema."
          >
            {escalations.length === 0 ? (
              <div className="p-4 text-center text-[12px]" style={{ color: C.textMuted }}>No escalations</div>
            ) : (
              <table className="w-full border-collapse">
                <thead><tr><TH>Severity</TH><TH>Title</TH><TH>By</TH><TH>Age</TH><TH>Acked</TH></tr></thead>
                <tbody>
                  {escalations.map(e => (
                    <tr key={e.id} onMouseEnter={el => (el.currentTarget.style.background = C.bgCardHover)} onMouseLeave={el => (el.currentTarget.style.background = 'transparent')}>
                      <TD><Badge color={e.severity === 'critical' ? 'red' : e.severity === 'high' ? 'orange' : e.severity === 'medium' ? 'yellow' : 'muted'}>{e.severity}</Badge></TD>
                      <TD>{e.title}</TD>
                      <TD><span style={{ color: C.textSecondary }}>{e.escalatedBy}</span></TD>
                      <TD>{e.age}</TD>
                      <TD>{e.acked ? <span style={{ color: C.green }}>✓</span> : <span style={{ color: C.red }}>✗</span>}</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* Issues/Backlog Panel */}
          <Panel title="📋 Issues" count={issues.length} showHelp={showHelp}
            description="Backlog de tarefas pendentes (como um Kanban). P1 = critica, P2 = alta, P3 = media, P4 = baixa. Assignee em roxo = agente responsavel, traco = ninguem pegou ainda."
          >
            {issues.length === 0 ? (
              <div className="p-4 text-center text-[12px]" style={{ color: C.textMuted }}>No open issues</div>
            ) : (
              <table className="w-full border-collapse">
                <thead><tr><TH>ID</TH><TH>Title</TH><TH>P</TH><TH>Type</TH><TH>Assignee</TH><TH>Age</TH></tr></thead>
                <tbody>
                  {issues.map(iss => (
                    <tr key={iss.id} onMouseEnter={e => (e.currentTarget.style.background = C.bgCardHover)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <TD><span style={{ color: C.textSecondary }}>{iss.id}</span></TD>
                      <TD><span className="text-[11px]">{iss.title}</span></TD>
                      <TD><span style={{ color: iss.priority <= 2 ? C.red : C.textMuted }}>P{iss.priority}</span></TD>
                      <TD><span className="text-[10px]" style={{ color: C.textMuted }}>{iss.type}</span></TD>
                      <TD>{iss.assignee ? <span style={{ color: C.purple }}>{iss.assignee}</span> : <span style={{ color: C.textMuted }}>—</span>}</TD>
                      <TD><span style={{ color: C.textMuted }}>{iss.age}</span></TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* Hooks Panel */}
          <Panel title="🪝 Hooks" count={hooks.length} countAlert={hooks.some(h => h.isStale)} showHelp={showHelp}
            description="Mecanismo central do Gas Town (GUPP). Quando uma tarefa e 'enganchada' a um agente, ele automaticamente a executa. Relogio = stale (parado ha mais de 1 hora, possivel problema)."
          >
            {hooks.length === 0 ? (
              <div className="p-4 text-center text-[12px]" style={{ color: C.textMuted }}>No active hooks</div>
            ) : (
              <table className="w-full border-collapse">
                <thead><tr><TH>Bead</TH><TH>Title</TH><TH>Agent</TH><TH>Age</TH></tr></thead>
                <tbody>
                  {hooks.map(h => (
                    <tr key={h.id} onMouseEnter={e => (e.currentTarget.style.background = C.bgCardHover)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <TD><span style={{ color: C.textSecondary }}>{h.id}</span></TD>
                      <TD>{h.title}</TD>
                      <TD><span style={{ color: C.purple }}>{h.agent}</span></TD>
                      <TD>
                        <span style={{ color: h.isStale ? C.yellow : C.textMuted }}>{h.age}</span>
                        {h.isStale && <span className="ml-1 text-[9px]" style={{ color: C.yellow }}>⏰</span>}
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* ═══ GT CLI Terminal ═══ */}
          <Panel title="⌨️ GT CLI" count={cliHistory.length} showHelp={showHelp}
            description="Terminal interativo do Gas Town. Digite comandos como: cook, sling, nudge, seance, handoff, convoy, plugins, mall, guzzoline, status, workers, beads, mail, schedule."
          >
            <div className="px-3 py-2" style={{ borderBottom: `1px solid ${C.border}` }}>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold" style={{ color: C.green }}>gt $</span>
                <input
                  value={cliInput}
                  onChange={e => setCliInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCliSubmit()}
                  className="flex-1 bg-transparent border-none outline-none text-[12px] font-mono"
                  style={{ color: C.textPrimary }}
                  placeholder="type command..."
                  disabled={cliLoading}
                />
                <button onClick={handleCliSubmit} className="text-[10px] px-2 py-0.5 rounded"
                  style={{ border: `1px solid ${C.border}`, color: C.cyan, background: 'transparent' }}
                >Run</button>
              </div>
            </div>
            <div className="max-h-[200px] overflow-y-auto">
              {cliHistory.map((h, i) => (
                <div key={i} className="px-3 py-1.5 flex items-center justify-between" style={{ borderBottom: `1px solid ${C.border}` }}>
                  <div className="flex-1 min-w-0">
                    <span className="text-[11px] font-mono" style={{ color: C.cyan }}>$ {h.cmd}</span>
                    <span className="text-[10px] ml-2" style={{ color: C.textMuted }}>→ {h.result}</span>
                  </div>
                  <span className="text-[10px] flex-shrink-0" style={{ color: C.textMuted }}>{h.time}</span>
                </div>
              ))}
            </div>
          </Panel>

          {/* ═══ Guzzoline Reservoir ═══ */}
          <Panel title="⛽ Guzzoline" count={DEMO_GUZZOLINE.level} showHelp={showHelp}
            description="Reservatorio de combustivel do sistema. Mede a capacidade de trabalho: quantas beads prontas, slots de polecat, orcamento, cota de API e espaco na fila de merge. Generators enchem, Consumers drenam."
          >
            <div className="px-3 py-2 space-y-3">
              {/* Fuel Bar */}
              <div>
                <div className="flex justify-between text-[11px] mb-1">
                  <span style={{ color: C.textSecondary }}>Fuel Level</span>
                  <span style={{ color: DEMO_GUZZOLINE.level < 20 ? C.red : DEMO_GUZZOLINE.level < 40 ? C.yellow : C.green }}>
                    {DEMO_GUZZOLINE.level}/{DEMO_GUZZOLINE.capacity} ({DEMO_GUZZOLINE.fuelStatus})
                  </span>
                </div>
                <div className="h-3 rounded-sm overflow-hidden" style={{ background: C.border }}>
                  <div className="h-full rounded-sm transition-all" style={{
                    width: `${DEMO_GUZZOLINE.level}%`,
                    background: DEMO_GUZZOLINE.level < 20 ? C.red : DEMO_GUZZOLINE.level < 40 ? C.yellow : C.green,
                    boxShadow: `0 0 8px ${DEMO_GUZZOLINE.level < 20 ? C.red : DEMO_GUZZOLINE.level < 40 ? C.yellow : C.green}40`,
                  }} />
                </div>
              </div>
              {/* Rates */}
              <div className="flex gap-4 text-[10px]">
                <span style={{ color: C.green }}>+{DEMO_GUZZOLINE.fillRate}/hr fill</span>
                <span style={{ color: C.red }}>-{DEMO_GUZZOLINE.burnRate}/hr burn</span>
                <span style={{ color: (DEMO_GUZZOLINE.fillRate - DEMO_GUZZOLINE.burnRate) >= 0 ? C.green : C.red }}>
                  Net: {(DEMO_GUZZOLINE.fillRate - DEMO_GUZZOLINE.burnRate).toFixed(1)}/hr
                </span>
              </div>
              {/* Breakdown */}
              <div className="grid grid-cols-3 gap-2 text-[10px]">
                {[
                  { label: 'Beads Ready', val: DEMO_GUZZOLINE.breakdown.beadsReady, color: C.cyan },
                  { label: 'Polecat Slots', val: DEMO_GUZZOLINE.breakdown.polecatSlots, color: C.purple },
                  { label: 'Budget', val: `$${DEMO_GUZZOLINE.breakdown.budgetRemaining.toFixed(0)}`, color: C.green },
                  { label: 'API Quota', val: `${DEMO_GUZZOLINE.breakdown.apiQuota}%`, color: C.blue },
                  { label: 'Merge Space', val: `${DEMO_GUZZOLINE.breakdown.mergeQueueSpace}%`, color: C.yellow },
                ].map(b => (
                  <div key={b.label} className="px-2 py-1.5 rounded" style={{ background: C.bgDark }}>
                    <div style={{ color: C.textMuted }}>{b.label}</div>
                    <div className="font-bold text-[13px]" style={{ color: b.color }}>{b.val}</div>
                  </div>
                ))}
              </div>
              {/* Generators & Consumers */}
              <div className="grid grid-cols-2 gap-2 text-[10px]">
                <div>
                  <div className="font-semibold mb-1" style={{ color: C.green }}>Generators</div>
                  {DEMO_GUZZOLINE.generators.map(g => (
                    <div key={g.name} className="flex justify-between py-0.5">
                      <span style={{ color: C.textSecondary }}>{g.name}</span>
                      <span style={{ color: C.green }}>+{g.rate}/hr</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="font-semibold mb-1" style={{ color: C.red }}>Consumers</div>
                  {DEMO_GUZZOLINE.consumers.map(c => (
                    <div key={c.name} className="flex justify-between py-0.5">
                      <span style={{ color: C.textSecondary }}>{c.name}</span>
                      <span style={{ color: C.red }}>-{c.rate}/hr</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Panel>

          {/* ═══ NDI — Three Pillars ═══ */}
          <Panel title="🏛️ NDI Status" count={DEMO_NDI.pillars.filter(p => p.status === 'intact').length} showHelp={showHelp}
            description="Nondeterministic Idempotence — os 3 pilares de persistencia. Se QUALQUER pilar esta intacto, o trabalho pode ser recuperado. Sessoes morrem; o trabalho sobrevive. Agent Bead = identidade, Hook Bead = atribuicao, Molecule Chain = execucao."
          >
            <div className="px-3 py-2 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px]" style={{ color: C.textSecondary }}>Overall: <span style={{ color: DEMO_NDI.overallStatus === 'healthy' ? C.green : DEMO_NDI.overallStatus === 'degraded' ? C.yellow : C.red }}>{DEMO_NDI.overallStatus}</span></span>
                <Badge color={DEMO_NDI.idempotent ? 'green' : 'red'}>{DEMO_NDI.idempotent ? 'Safe to Retry' : 'Manual Only'}</Badge>
              </div>
              {DEMO_NDI.pillars.map(p => (
                <div key={p.name} className="px-2 py-2 rounded" style={{ background: C.bgDark, border: `1px solid ${p.status === 'intact' ? C.green + '30' : p.status === 'degraded' ? C.yellow + '30' : C.red + '30'}` }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-semibold" style={{ color: C.textPrimary }}>
                      {p.name === 'agent_bead' ? '👤 Agent Bead' : p.name === 'hook_bead' ? '🪝 Hook Bead' : '🧬 Molecule Chain'}
                    </span>
                    <Badge color={p.status === 'intact' ? 'green' : p.status === 'degraded' ? 'yellow' : 'red'}>{p.status}</Badge>
                  </div>
                  <div className="text-[10px]" style={{ color: C.textMuted }}>
                    <div>Location: {p.location}</div>
                    <div>Recovery: {p.recoveryMethod}</div>
                  </div>
                </div>
              ))}
              <div className="text-[10px] px-1" style={{ color: C.textMuted }}>
                &quot;Sessions are cattle. Agents are persistent identities.&quot;
              </div>
            </div>
          </Panel>

          {/* ═══ MEOW Bond Operators ═══ */}
          <Panel title="⚗️ Bond Operators" count={DEMO_BOND_OPS.length} showHelp={showHelp}
            description="Algebra MEOW — como os estados se transformam. cook: congela formula em proto. pour: ativa proto em molecula. wisp: cria fantasma efemero. squash: compacta molecula. burn: destroi wisp. compound: compoe formulas. synthesize: funde resultados."
          >
            <div className="max-h-[300px] overflow-y-auto">
              {DEMO_BOND_OPS.map(op => (
                <div key={op.operator} className="px-3 py-2" style={{ borderBottom: `1px solid ${C.border}` }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[12px] font-bold px-1.5 py-0.5 rounded" style={{ background: C.purple + '20', color: C.purple }}>{op.operator}</span>
                    <span className="text-[10px]" style={{ color: C.textMuted }}>{op.phase}</span>
                  </div>
                  <div className="text-[11px] flex items-center gap-1.5">
                    <span style={{ color: C.blue }}>{op.operandA}</span>
                    <span style={{ color: C.textMuted }}>+</span>
                    <span style={{ color: C.cyan }}>{op.operandB}</span>
                    <span style={{ color: C.textMuted }}>→</span>
                    <span style={{ color: C.green }}>{op.result}</span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          {/* ═══ Plugins / Extension Manifest ═══ */}
          <Panel title="🔌 Plugins" count={DEMO_PLUGINS.length} showHelp={showHelp}
            description="Sistema de extensoes em 3 niveis: Town (monitoramento global), Rig (por-repositorio: lint, typecheck, testes), Refinery (merge pipeline: code review, security, changelog). Cada plugin pode ter Gates que bloqueiam merge ate passar."
          >
            <div className="max-h-[280px] overflow-y-auto">
              {(['town', 'rig', 'refinery'] as const).map(level => {
                const plugins = DEMO_PLUGINS.filter(p => p.level === level);
                return (
                  <div key={level}>
                    <div className="px-3 py-1.5 text-[10px] uppercase font-semibold tracking-wider" style={{ background: C.bgDark, color: level === 'town' ? C.cyan : level === 'rig' ? C.blue : C.purple }}>
                      {level} ({plugins.length})
                    </div>
                    {plugins.map(p => (
                      <div key={p.id} className="px-3 py-1.5 flex items-center justify-between" style={{ borderBottom: `1px solid ${C.border}` }}>
                        <div className="flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.status === 'enabled' ? C.green : C.red }} />
                          <span className="text-[11px]" style={{ color: C.textPrimary }}>{p.name}</span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px]">
                          <span style={{ color: C.textMuted }}>{p.runs} runs</span>
                          {p.gates > 0 && <span className="px-1 rounded" style={{ background: C.orange + '20', color: C.orange }}>{p.gates} gates</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* ═══ Mol Mall ═══ */}
          <Panel title="🏪 Mol Mall" count={DEMO_MALL.length} showHelp={showHelp}
            description="Marketplace de formulas TOML reutilizaveis. Cada formula define um workflow completo (como um template). Instale formulas prontas, classifique e publique novas. Categorias: workflow, patrol, release, test, deploy."
          >
            <div className="max-h-[280px] overflow-y-auto">
              {DEMO_MALL.map(f => (
                <div key={f.name} className="px-3 py-2" style={{ borderBottom: `1px solid ${C.border}` }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[12px] font-semibold" style={{ color: C.blue }}>{f.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px]" style={{ color: C.yellow }}>★{f.rating}</span>
                      <span className="text-[10px] px-1 rounded" style={{ background: C.border, color: C.textMuted }}>{f.category}</span>
                    </div>
                  </div>
                  <div className="text-[10px]" style={{ color: C.textSecondary }}>{f.description}</div>
                  <div className="flex gap-3 mt-1 text-[10px]" style={{ color: C.textMuted }}>
                    <span>v{f.version}</span>
                    <span>{f.steps} steps</span>
                    <span>{f.installs} installs</span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          {/* ═══ Compound Formulas ═══ */}
          <Panel title="🔗 Compounds" count={DEMO_COMPOUNDS.length} showHelp={showHelp}
            description="Formulas compostas que orquestram sub-formulas. Sequential = uma apos outra. Parallel = todas ao mesmo tempo. Fan-out = distribui entre rigs e depois sintetiza. Cada compound pode ter condicoes (ex: so avanca se anterior passou)."
          >
            {DEMO_COMPOUNDS.map(cf => (
              <div key={cf.id} className="px-3 py-2" style={{ borderBottom: `1px solid ${C.border}` }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12px] font-semibold" style={{ color: C.textPrimary }}>{cf.name}</span>
                  <Badge color={cf.strategy === 'sequential' ? 'blue' : cf.strategy === 'parallel' ? 'green' : 'purple'}>{cf.strategy}</Badge>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {cf.subs.map((s, i) => (
                    <span key={i} className="flex items-center gap-1">
                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: C.blue + '15', color: C.blue }}>{s}</span>
                      {i < cf.subs.length - 1 && <span className="text-[10px]" style={{ color: C.textMuted }}>{cf.strategy === 'parallel' ? '∥' : '→'}</span>}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </Panel>

          {/* ═══ Polecat Lease Lifecycle ═══ */}
          <Panel title="🦨 Polecat Lease" count={4} showHelp={showHelp}
            description="Ciclo de vida de um Polecat (agente efemero). 4 estados: RUN (codando), VERIFYING (CI rodando), MANUAL_REQUESTED (precisa humano), STUCK (morto/travado). Transicoes automaticas exceto STUCK que requer intervencao."
          >
            <div className="px-3 py-2 space-y-1">
              {DEMO_POLECAT_LEASE.map((s, i) => (
                <div key={s.state} className="flex items-center gap-3">
                  <div className="flex items-center gap-2 w-32">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color, boxShadow: `0 0 6px ${s.color}40` }} />
                    <span className="text-[12px] font-bold" style={{ color: s.color }}>{s.state}</span>
                  </div>
                  <span className="text-[11px]" style={{ color: C.textSecondary }}>{s.label}</span>
                  <span className="text-[10px]" style={{ color: C.textMuted }}>— {s.description}</span>
                  {i < DEMO_POLECAT_LEASE.length - 1 && (
                    <span className="text-[10px]" style={{ color: C.textMuted }}>↓</span>
                  )}
                </div>
              ))}
              <div className="text-[10px] mt-2 px-1" style={{ color: C.textMuted }}>
                Lifecycle: RUN → VERIFYING → (pass: done | fail: RUN) | MANUAL_REQUESTED → (approve: RUN) | STUCK → (seance/reboot)
              </div>
            </div>
          </Panel>

          {/* ═══ 20-Step Beads Release Pipeline ═══ */}
          <Panel title="🚀 Beads Release" count={20} showHelp={showHelp}
            description="Pipeline CHROME Enterprise Grade de 20 passos para release. Cada bead (tarefa) passa por TODOS os 20 checkpoints antes de ser considerada concluida. Verde = concluido, azul = em progresso, cinza = pendente."
          >
            <div className="px-3 py-2">
              <div className="grid grid-cols-4 gap-1">
                {DEMO_BEADS_PIPELINE.map((step, i) => {
                  const status = i < 14 ? 'done' : i === 14 ? 'active' : 'pending';
                  return (
                    <div key={i} className="text-center py-1.5 px-1 rounded text-[9px]" style={{
                      background: status === 'done' ? C.green + '15' : status === 'active' ? C.blue + '20' : C.bgDark,
                      border: `1px solid ${status === 'done' ? C.green + '30' : status === 'active' ? C.blue + '40' : C.border}`,
                      color: status === 'done' ? C.green : status === 'active' ? C.blue : C.textMuted,
                    }}>
                      <div className="font-mono font-bold">{String(i + 1).padStart(2, '0')}</div>
                      <div className="truncate">{step}</div>
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between mt-2 text-[10px]">
                <span style={{ color: C.green }}>✓ 14 done</span>
                <span style={{ color: C.blue }}>→ 1 active</span>
                <span style={{ color: C.textMuted }}>○ 5 pending</span>
              </div>
            </div>
          </Panel>

          {/* ═══ Seance Log ═══ */}
          <Panel title="👻 Seance Log" count={DEMO_SEANCE_LOG.length} showHelp={showHelp}
            description="Registro de sessoes mortas recuperadas via 'gt seance'. Quando um agente morre (timeout, crash, OOM), o seance reconstroi o contexto a partir dos 3 pilares NDI e permite re-sling do trabalho."
          >
            {DEMO_SEANCE_LOG.length === 0 ? (
              <div className="p-4 text-center text-[12px]" style={{ color: C.textMuted }}>No seances performed</div>
            ) : (
              <div>
                {DEMO_SEANCE_LOG.map(s => (
                  <div key={s.id} className="px-3 py-2" style={{ borderBottom: `1px solid ${C.border}` }}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-semibold" style={{ color: C.purple }}>{s.session}</span>
                      <span className="text-[10px]" style={{ color: C.textMuted }}>{s.time}</span>
                    </div>
                    <div className="flex gap-3 text-[10px]">
                      <span style={{ color: C.textSecondary }}>Agent: {s.agent}</span>
                      <span style={{ color: C.red }}>Death: {s.deathReason}</span>
                      <span style={{ color: C.cyan }}>Beads recovered: {s.beadsRecovered}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

        </div>

        {/* ── Quick Nav to Detail Views ───────────────────────────────── */}
        {showHelp && (
          <p className="text-[10px] m-0 px-1" style={{ color: C.cyan + 'aa' }}>
            Atalhos para views detalhadas de cada subsistema. Cada botao abre uma tela dedicada com informacoes expandidas.
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-2" style={{ borderTop: `1px solid ${C.border}` }}>
          {[
            { view: 'meow-molecules', label: '🧬 Molecules', tip: 'Unidades atomicas de codigo que os agentes manipulam' },
            { view: 'meow-beads', label: '📿 Beads', tip: 'Todas as unidades de trabalho (tarefas individuais)' },
            { view: 'meow-convoys', label: '🚚 Convoys Detail', tip: 'Visao expandida dos comboios com sub-tarefas' },
            { view: 'meow-workers', label: '👷 Worker Pool', tip: 'Pool completo de agentes com metricas detalhadas' },
            { view: 'meow-mayor', label: '🎩 Mayor', tip: 'Painel do Mayor com historico de decisoes' },
            { view: 'meow-observatory', label: '🔭 Observatory', tip: 'Metricas de observabilidade (health, performance, erros)' },
            { view: 'meow-refinery', label: '⚗️ Refinery', tip: 'Processador permanente que refina e melhora codigo' },
            { view: 'meow-patrol', label: '🛡️ Patrol', tip: 'Sistema de patrulha que verifica qualidade do codigo' },
            { view: 'meow-skills', label: '🔧 Skills', tip: 'Habilidades registradas dos agentes' },
            { view: 'meow-wisps', label: '💨 Wisps', tip: 'Sinais fracos e insights capturados pelos agentes' },
            { view: 'meow-quality-gate', label: '✅ Quality Gate', tip: 'Portao de qualidade — checklist antes de mergear' },
            { view: 'gastown-timeline', label: '📅 Timeline', tip: 'Timeline completa de toda a operacao' },
            { view: 'gastown-guzzoline', label: '⛽ Guzzoline', tip: 'Reservatorio de combustivel — capacidade do sistema' },
            { view: 'gastown-ndi', label: '🏛️ NDI', tip: 'Status dos 3 pilares de persistencia' },
            { view: 'gastown-plugins', label: '🔌 Plugins', tip: 'Extensoes em 3 niveis: Town, Rig, Refinery' },
            { view: 'gastown-mall', label: '🏪 Mol Mall', tip: 'Marketplace de formulas TOML' },
            { view: 'gastown-cli', label: '⌨️ CLI', tip: 'Terminal completo com 15 comandos GT' },
            { view: 'gastown-seance', label: '👻 Seance', tip: 'Recuperacao de sessoes mortas' },
            { view: 'gastown-bonds', label: '⚗️ Bond Ops', tip: 'Algebra MEOW: cook, pour, wisp, squash, burn' },
            { view: 'gastown-compounds', label: '🔗 Compounds', tip: 'Formulas compostas multi-step' },
            { view: 'gastown-release', label: '🚀 Release', tip: 'Pipeline 20-step CHROME Enterprise Grade' },
          ].map(link => (
            <button
              key={link.view}
              onClick={() => navigate(link.view)}
              className="text-[11px] px-2.5 py-1.5 rounded transition-colors"
              style={{
                border: `1px solid ${C.border}`,
                color: C.textSecondary,
                background: 'transparent',
              }}
              title={link.tip}
              onMouseEnter={e => { e.currentTarget.style.borderColor = C.cyan + '50'; e.currentTarget.style.color = C.cyan; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textSecondary; }}
            >
              {link.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

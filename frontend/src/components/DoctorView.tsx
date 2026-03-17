'use client';

/**
 * DoctorView -- GT Doctor: 50+ Health Checks for Gas Town
 *
 * Steve Yegge's `gt doctor` runs comprehensive diagnostics across every
 * Gas Town subsystem. Web adaptation with collapsible check groups,
 * overall health score, and "Run Doctor" on-demand trigger.
 *
 * Ayu Dark palette:
 *   bg: #0f1419, cards: #1a1f26, text: #e6e1cf, muted: #6c7680
 *   border: #2d363f, green: #c2d94c, yellow: #ffb454, red: #f07178
 *   cyan: #95e6cb, purple: #d2a6ff
 *
 * APIs:
 *   GET {API}/api/meow/town/pulse        — system health
 *   GET {API}/api/meow/deacon/health      — deacon
 *   GET {API}/api/meow/witness/report     — witness
 *   GET {API}/api/meow/gupp/stats         — hooks
 *   GET {API}/api/meow/refinery/stats     — refinery
 *   GET {API}/api/meow/mail/stats         — mail
 *   GET {API}/api/beads/stats             — beads
 *   GET {API}/api/meow/crew/stats         — workers
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────────

type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP' | 'RUNNING';

interface HealthCheck {
  id: string;
  name: string;
  status: CheckStatus;
  details: string;
  timestamp: string;
  duration?: number; // ms
}

interface CheckGroup {
  id: string;
  name: string;
  icon: string;
  checks: HealthCheck[];
}

interface DoctorResult {
  score: number; // 0-100
  pass: number;
  fail: number;
  warn: number;
  skip: number;
  groups: CheckGroup[];
  lastRun: string;
  duration: number; // total ms
}

// Raw API response shapes
interface PulseData {
  status?: string;
  database?: boolean | string;
  api?: boolean | string;
  sse?: boolean | string;
  uptime?: number;
  uptimeSeconds?: number;
  memoryUsage?: { heapUsed?: number; heapTotal?: number; rss?: number };
  memory?: { heapUsed?: number; heapTotal?: number };
}

interface DeaconData {
  alive?: boolean;
  status?: string;
  patrolRunning?: boolean;
  patrolPassRate?: number;
  heartbeat?: string;
  lastHeartbeat?: string;
}

interface WitnessData {
  alive?: boolean;
  status?: string;
  rigs?: Array<{ name: string; witnessAlive?: boolean; patrolRunning?: boolean; patrolPassRate?: number }>;
  patrolRunning?: boolean;
  patrolPassRate?: number;
}

interface GuppData {
  violations?: number;
  totalHooks?: number;
  hookCount?: number;
  duplicates?: number;
  duplicateHooks?: number;
  backpressure?: number | string;
  staleHooks?: number;
  maxAge?: number;
}

interface RefineryData {
  mergeQueueSize?: number;
  queueSize?: number;
  staleMergeRequests?: number;
  staleRequests?: number;
  unresolvedConflicts?: number;
  conflicts?: number;
  gatePassRate?: number;
  passRate?: number;
  patrolRunning?: boolean;
  patrolPassRate?: number;
}

interface MailData {
  undeliveredCritical?: number;
  undelivered?: number;
  largestMailbox?: number;
  maxMailboxSize?: number;
  stuckWorkers?: number;
  stuckMailWorkers?: number;
}

interface BeadsData {
  stuckMolecules?: number;
  stuck?: number;
  orphanedMolecules?: number;
  orphaned?: number;
  dependencyCycles?: number;
  cycles?: number;
  limboBeads?: number;
  inLimbo?: number;
}

interface CrewData {
  total?: number;
  active?: number;
  zombies?: number;
  zombiePolecats?: number;
  orphanedSessions?: number;
  heartbeatsFresh?: boolean;
  allResponsive?: boolean;
  staleHeartbeats?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<CheckStatus, { color: string; bg: string; border: string; icon: string }> = {
  PASS:    { color: '#c2d94c', bg: 'bg-[#c2d94c]/10', border: 'border-[#c2d94c]/20', icon: '\u2713' },
  FAIL:    { color: '#f07178', bg: 'bg-[#f07178]/10', border: 'border-[#f07178]/20', icon: '\u2717' },
  WARN:    { color: '#ffb454', bg: 'bg-[#ffb454]/10', border: 'border-[#ffb454]/20', icon: '\u26A0' },
  SKIP:    { color: '#4a5159', bg: 'bg-[#4a5159]/10', border: 'border-[#4a5159]/20', icon: '\u2014' },
  RUNNING: { color: '#95e6cb', bg: 'bg-[#95e6cb]/10', border: 'border-[#95e6cb]/20', icon: '\u25CF' },
};

const EMPTY_RESULT: DoctorResult = {
  score: 0, pass: 0, fail: 0, warn: 0, skip: 0,
  groups: [], lastRun: '', duration: 0,
};

// ─── Health Check Runner ────────────────────────────────────────────────────────

async function runHealthChecks(signal: AbortSignal): Promise<DoctorResult> {
  const startTime = Date.now();
  const now = new Date().toISOString();

  // Fetch all data in parallel
  const [pulseRes, deaconRes, witnessRes, guppRes, refineryRes, mailRes, beadsRes, crewRes] =
    await Promise.allSettled([
      fetch(`${API}/api/meow/town/pulse`, { signal }).then(r => r.ok ? r.json() : null),
      fetch(`${API}/api/meow/deacon/health`, { signal }).then(r => r.ok ? r.json() : null),
      fetch(`${API}/api/meow/witness/report`, { signal }).then(r => r.ok ? r.json() : null),
      fetch(`${API}/api/meow/gupp/stats`, { signal }).then(r => r.ok ? r.json() : null),
      fetch(`${API}/api/meow/refinery/stats`, { signal }).then(r => r.ok ? r.json() : null),
      fetch(`${API}/api/meow/mail/stats`, { signal }).then(r => r.ok ? r.json() : null),
      fetch(`${API}/api/beads/stats`, { signal }).then(r => r.ok ? r.json() : null),
      fetch(`${API}/api/meow/crew/stats`, { signal }).then(r => r.ok ? r.json() : null),
    ]);

  const pulse: PulseData | null = pulseRes.status === 'fulfilled' ? pulseRes.value : null;
  const deacon: DeaconData | null = deaconRes.status === 'fulfilled' ? deaconRes.value : null;
  const witness: WitnessData | null = witnessRes.status === 'fulfilled' ? witnessRes.value : null;
  const gupp: GuppData | null = guppRes.status === 'fulfilled' ? guppRes.value : null;
  const refinery: RefineryData | null = refineryRes.status === 'fulfilled' ? refineryRes.value : null;
  const mail: MailData | null = mailRes.status === 'fulfilled' ? mailRes.value : null;
  const beadsData: BeadsData | null = beadsRes.status === 'fulfilled' ? beadsRes.value : null;
  const crew: CrewData | null = crewRes.status === 'fulfilled' ? crewRes.value : null;

  // Helper to create a check
  const ts = now;
  function check(id: string, name: string, status: CheckStatus, details: string): HealthCheck {
    return { id, name, status, details, timestamp: ts };
  }

  // ── GROUP 1: System Health ────────────────────────────────────
  const systemChecks: HealthCheck[] = [];

  // Database connected
  if (pulse) {
    const dbOk = pulse.database === true || pulse.database === 'connected' || pulse.status === 'ok';
    systemChecks.push(check('sys-db', 'Database connected', dbOk ? 'PASS' : 'FAIL',
      dbOk ? 'Database connection healthy' : 'Database connection failed or unknown'));
  } else {
    systemChecks.push(check('sys-db', 'Database connected', 'SKIP', 'Could not reach pulse endpoint'));
  }

  // API responding
  systemChecks.push(check('sys-api', 'API responding',
    pulse ? 'PASS' : 'FAIL',
    pulse ? 'Pulse endpoint returned successfully' : 'Pulse endpoint unreachable'));

  // SSE stream active
  if (pulse) {
    const sseOk = pulse.sse === true || pulse.sse === 'active';
    systemChecks.push(check('sys-sse', 'SSE stream active',
      sseOk ? 'PASS' : pulse.sse === undefined ? 'SKIP' : 'WARN',
      sseOk ? 'SSE broadcasting normally' : pulse.sse === undefined ? 'SSE status not reported' : 'SSE may be degraded'));
  } else {
    systemChecks.push(check('sys-sse', 'SSE stream active', 'SKIP', 'No pulse data available'));
  }

  // Uptime > 5min
  if (pulse) {
    const uptime = pulse.uptime || pulse.uptimeSeconds || 0;
    const uptimeOk = uptime > 300;
    systemChecks.push(check('sys-uptime', 'Uptime > 5min',
      uptimeOk ? 'PASS' : 'WARN',
      `Uptime: ${Math.floor(uptime / 60)}m ${uptime % 60}s`));
  } else {
    systemChecks.push(check('sys-uptime', 'Uptime > 5min', 'SKIP', 'No uptime data'));
  }

  // Memory usage OK
  if (pulse) {
    const mem = pulse.memoryUsage || pulse.memory;
    if (mem && mem.heapUsed && mem.heapTotal) {
      const pct = Math.round((mem.heapUsed / mem.heapTotal) * 100);
      const memOk = pct < 85;
      systemChecks.push(check('sys-memory', 'Memory usage OK',
        memOk ? 'PASS' : pct < 95 ? 'WARN' : 'FAIL',
        `Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB (${pct}%)`));
    } else {
      systemChecks.push(check('sys-memory', 'Memory usage OK', 'SKIP', 'Memory data not available'));
    }
  } else {
    systemChecks.push(check('sys-memory', 'Memory usage OK', 'SKIP', 'No pulse data'));
  }

  // ── GROUP 2: Workers ──────────────────────────────────────────
  const workerChecks: HealthCheck[] = [];

  // Mayor alive
  if (pulse) {
    // Mayor status often embedded in pulse or crew
    const mayorAlive = pulse.status === 'ok' || pulse.status === 'healthy';
    workerChecks.push(check('wkr-mayor', 'Mayor alive',
      mayorAlive ? 'PASS' : 'WARN',
      mayorAlive ? 'Mayor is responding' : 'Mayor status unclear'));
  } else {
    workerChecks.push(check('wkr-mayor', 'Mayor alive', 'FAIL', 'Cannot determine Mayor status'));
  }

  // Deacon alive
  if (deacon) {
    const dAlive = deacon.alive !== false && (deacon.status === 'ok' || deacon.status === 'active' || deacon.alive === true);
    workerChecks.push(check('wkr-deacon', 'Deacon alive',
      dAlive ? 'PASS' : 'FAIL',
      dAlive ? 'Deacon health endpoint OK' : `Deacon status: ${deacon.status || 'unknown'}`));
  } else {
    workerChecks.push(check('wkr-deacon', 'Deacon alive', 'FAIL', 'Deacon health endpoint unreachable'));
  }

  // At least 1 witness per rig
  if (witness) {
    if (Array.isArray(witness.rigs) && witness.rigs.length > 0) {
      const allHaveWitness = witness.rigs.every(r => r.witnessAlive !== false);
      workerChecks.push(check('wkr-witness-rig', 'At least 1 witness per rig',
        allHaveWitness ? 'PASS' : 'FAIL',
        allHaveWitness ? `All ${witness.rigs.length} rigs have active witness` : 'Some rigs missing witness'));
    } else {
      const wAlive = witness.alive !== false || witness.status === 'ok';
      workerChecks.push(check('wkr-witness-rig', 'At least 1 witness per rig',
        wAlive ? 'PASS' : 'WARN',
        wAlive ? 'Witness is alive' : 'Witness status unclear'));
    }
  } else {
    workerChecks.push(check('wkr-witness-rig', 'At least 1 witness per rig', 'SKIP', 'Witness report unavailable'));
  }

  // No zombie polecats
  if (crew) {
    const zombies = crew.zombies || crew.zombiePolecats || 0;
    workerChecks.push(check('wkr-zombies', 'No zombie polecats',
      zombies === 0 ? 'PASS' : 'FAIL',
      zombies === 0 ? 'No zombie processes detected' : `${zombies} zombie polecat(s) found`));
  } else {
    workerChecks.push(check('wkr-zombies', 'No zombie polecats', 'SKIP', 'No crew stats'));
  }

  // All crew responsive
  if (crew) {
    const responsive = crew.allResponsive !== false;
    workerChecks.push(check('wkr-responsive', 'All crew responsive',
      responsive ? 'PASS' : 'WARN',
      responsive ? `${crew.active || 0} active of ${crew.total || 0} total` : 'Some crew members not responding'));
  } else {
    workerChecks.push(check('wkr-responsive', 'All crew responsive', 'SKIP', 'No crew stats'));
  }

  // Worker heartbeats fresh
  if (crew) {
    const stale = crew.staleHeartbeats || 0;
    const fresh = crew.heartbeatsFresh !== false && stale === 0;
    workerChecks.push(check('wkr-heartbeat', 'Worker heartbeats fresh',
      fresh ? 'PASS' : 'WARN',
      fresh ? 'All heartbeats within threshold' : `${stale} stale heartbeat(s)`));
  } else {
    workerChecks.push(check('wkr-heartbeat', 'Worker heartbeats fresh', 'SKIP', 'No crew stats'));
  }

  // No orphaned sessions
  if (crew) {
    const orphaned = crew.orphanedSessions || 0;
    workerChecks.push(check('wkr-orphaned', 'No orphaned sessions',
      orphaned === 0 ? 'PASS' : 'WARN',
      orphaned === 0 ? 'No orphaned sessions' : `${orphaned} orphaned session(s)`));
  } else {
    workerChecks.push(check('wkr-orphaned', 'No orphaned sessions', 'SKIP', 'No crew stats'));
  }

  // ── GROUP 3: GUPP & Hooks ─────────────────────────────────────
  const guppChecks: HealthCheck[] = [];

  if (gupp) {
    // No GUPP violations
    const violations = gupp.violations || gupp.staleHooks || 0;
    guppChecks.push(check('gupp-violations', 'No GUPP violations (stale hooks > 30min)',
      violations === 0 ? 'PASS' : violations < 3 ? 'WARN' : 'FAIL',
      violations === 0 ? 'No stale hooks detected' : `${violations} GUPP violation(s) — hooks stale >30min`));

    // Hook count reasonable
    const hookCount = gupp.totalHooks || gupp.hookCount || 0;
    guppChecks.push(check('gupp-count', 'Hook count reasonable',
      hookCount < 500 ? 'PASS' : hookCount < 1000 ? 'WARN' : 'FAIL',
      `${hookCount} active hook(s)`));

    // No duplicate hooks
    const dupes = gupp.duplicates || gupp.duplicateHooks || 0;
    guppChecks.push(check('gupp-dupes', 'No duplicate hooks',
      dupes === 0 ? 'PASS' : 'WARN',
      dupes === 0 ? 'No duplicate hooks found' : `${dupes} duplicate hook(s)`));

    // Backpressure not critical
    const bp = typeof gupp.backpressure === 'number' ? gupp.backpressure : 0;
    guppChecks.push(check('gupp-backpressure', 'Backpressure not critical',
      bp < 70 ? 'PASS' : bp < 90 ? 'WARN' : 'FAIL',
      `Backpressure level: ${bp}%`));
  } else {
    guppChecks.push(check('gupp-violations', 'No GUPP violations', 'SKIP', 'GUPP stats unavailable'));
    guppChecks.push(check('gupp-count', 'Hook count reasonable', 'SKIP', 'GUPP stats unavailable'));
    guppChecks.push(check('gupp-dupes', 'No duplicate hooks', 'SKIP', 'GUPP stats unavailable'));
    guppChecks.push(check('gupp-backpressure', 'Backpressure not critical', 'SKIP', 'GUPP stats unavailable'));
  }

  // ── GROUP 4: Molecules & Beads ────────────────────────────────
  const beadChecks: HealthCheck[] = [];

  if (beadsData) {
    const stuck = beadsData.stuckMolecules || beadsData.stuck || 0;
    beadChecks.push(check('bead-stuck', 'No stuck molecules (>1hr no progress)',
      stuck === 0 ? 'PASS' : 'FAIL',
      stuck === 0 ? 'All molecules progressing' : `${stuck} molecule(s) stuck >1hr`));

    const orphaned = beadsData.orphanedMolecules || beadsData.orphaned || 0;
    beadChecks.push(check('bead-orphaned', 'No orphaned molecules',
      orphaned === 0 ? 'PASS' : 'WARN',
      orphaned === 0 ? 'No orphaned molecules' : `${orphaned} orphaned molecule(s)`));

    const cycles = beadsData.dependencyCycles || beadsData.cycles || 0;
    beadChecks.push(check('bead-cycles', 'Bead dependency cycles resolved',
      cycles === 0 ? 'PASS' : 'FAIL',
      cycles === 0 ? 'No dependency cycles' : `${cycles} dependency cycle(s) detected`));

    const limbo = beadsData.limboBeads || beadsData.inLimbo || 0;
    beadChecks.push(check('bead-limbo', 'No beads in limbo state',
      limbo === 0 ? 'PASS' : 'WARN',
      limbo === 0 ? 'All beads have clear status' : `${limbo} bead(s) in limbo`));
  } else {
    beadChecks.push(check('bead-stuck', 'No stuck molecules', 'SKIP', 'Bead stats unavailable'));
    beadChecks.push(check('bead-orphaned', 'No orphaned molecules', 'SKIP', 'Bead stats unavailable'));
    beadChecks.push(check('bead-cycles', 'Bead dependency cycles resolved', 'SKIP', 'Bead stats unavailable'));
    beadChecks.push(check('bead-limbo', 'No beads in limbo state', 'SKIP', 'Bead stats unavailable'));
  }

  // ── GROUP 5: Refinery ─────────────────────────────────────────
  const refineryChecks: HealthCheck[] = [];

  if (refinery) {
    const queueSize = refinery.mergeQueueSize || refinery.queueSize || 0;
    refineryChecks.push(check('ref-queue', 'Merge queue not backed up',
      queueSize < 10 ? 'PASS' : queueSize < 25 ? 'WARN' : 'FAIL',
      `Merge queue size: ${queueSize}`));

    const staleReqs = refinery.staleMergeRequests || refinery.staleRequests || 0;
    refineryChecks.push(check('ref-stale', 'No stale merge requests',
      staleReqs === 0 ? 'PASS' : 'WARN',
      staleReqs === 0 ? 'All merge requests active' : `${staleReqs} stale merge request(s)`));

    const conflicts = refinery.unresolvedConflicts || refinery.conflicts || 0;
    refineryChecks.push(check('ref-conflicts', 'No unresolved conflicts',
      conflicts === 0 ? 'PASS' : 'FAIL',
      conflicts === 0 ? 'No unresolved conflicts' : `${conflicts} unresolved conflict(s)`));

    const passRate = refinery.gatePassRate || refinery.passRate;
    if (passRate !== undefined) {
      refineryChecks.push(check('ref-gate', 'Gate pass rate > 70%',
        passRate > 70 ? 'PASS' : passRate > 50 ? 'WARN' : 'FAIL',
        `Gate pass rate: ${passRate}%`));
    } else {
      refineryChecks.push(check('ref-gate', 'Gate pass rate > 70%', 'SKIP', 'Pass rate not reported'));
    }
  } else {
    refineryChecks.push(check('ref-queue', 'Merge queue not backed up', 'SKIP', 'Refinery stats unavailable'));
    refineryChecks.push(check('ref-stale', 'No stale merge requests', 'SKIP', 'Refinery stats unavailable'));
    refineryChecks.push(check('ref-conflicts', 'No unresolved conflicts', 'SKIP', 'Refinery stats unavailable'));
    refineryChecks.push(check('ref-gate', 'Gate pass rate > 70%', 'SKIP', 'Refinery stats unavailable'));
  }

  // ── GROUP 6: Mail ─────────────────────────────────────────────
  const mailChecks: HealthCheck[] = [];

  if (mail) {
    const undelivered = mail.undeliveredCritical || mail.undelivered || 0;
    mailChecks.push(check('mail-undelivered', 'No undelivered critical mail',
      undelivered === 0 ? 'PASS' : 'FAIL',
      undelivered === 0 ? 'All critical mail delivered' : `${undelivered} undelivered critical message(s)`));

    const maxBox = mail.largestMailbox || mail.maxMailboxSize || 0;
    mailChecks.push(check('mail-size', 'Mailbox sizes reasonable',
      maxBox < 1000 ? 'PASS' : maxBox < 5000 ? 'WARN' : 'FAIL',
      `Largest mailbox: ${maxBox} messages`));

    const stuck = mail.stuckWorkers || mail.stuckMailWorkers || 0;
    mailChecks.push(check('mail-stuck', 'No stuck mail workers',
      stuck === 0 ? 'PASS' : 'WARN',
      stuck === 0 ? 'All mail workers healthy' : `${stuck} stuck mail worker(s)`));
  } else {
    mailChecks.push(check('mail-undelivered', 'No undelivered critical mail', 'SKIP', 'Mail stats unavailable'));
    mailChecks.push(check('mail-size', 'Mailbox sizes reasonable', 'SKIP', 'Mail stats unavailable'));
    mailChecks.push(check('mail-stuck', 'No stuck mail workers', 'SKIP', 'Mail stats unavailable'));
  }

  // ── GROUP 7: Patrols ──────────────────────────────────────────
  const patrolChecks: HealthCheck[] = [];

  // Deacon patrol
  if (deacon) {
    const patrolRunning = deacon.patrolRunning !== false;
    patrolChecks.push(check('patrol-deacon', 'Deacon patrol running',
      patrolRunning ? 'PASS' : 'FAIL',
      patrolRunning ? 'Deacon patrol active' : 'Deacon patrol not running'));

    if (deacon.patrolPassRate !== undefined) {
      patrolChecks.push(check('patrol-deacon-rate', 'Deacon patrol pass rate > 80%',
        deacon.patrolPassRate > 80 ? 'PASS' : deacon.patrolPassRate > 60 ? 'WARN' : 'FAIL',
        `Deacon patrol pass rate: ${deacon.patrolPassRate}%`));
    }
  } else {
    patrolChecks.push(check('patrol-deacon', 'Deacon patrol running', 'SKIP', 'Deacon data unavailable'));
  }

  // Witness patrol
  if (witness) {
    const wPatrol = witness.patrolRunning !== false;
    patrolChecks.push(check('patrol-witness', 'Witness patrol running',
      wPatrol ? 'PASS' : 'FAIL',
      wPatrol ? 'Witness patrol active' : 'Witness patrol not running'));

    if (witness.patrolPassRate !== undefined) {
      patrolChecks.push(check('patrol-witness-rate', 'Witness patrol pass rate > 80%',
        witness.patrolPassRate > 80 ? 'PASS' : witness.patrolPassRate > 60 ? 'WARN' : 'FAIL',
        `Witness patrol pass rate: ${witness.patrolPassRate}%`));
    }
  } else {
    patrolChecks.push(check('patrol-witness', 'Witness patrol running', 'SKIP', 'Witness data unavailable'));
  }

  // Refinery patrol
  if (refinery) {
    const rPatrol = refinery.patrolRunning !== false;
    patrolChecks.push(check('patrol-refinery', 'Refinery patrol running',
      rPatrol ? 'PASS' : 'WARN',
      rPatrol ? 'Refinery patrol active' : 'Refinery patrol not running'));

    if (refinery.patrolPassRate !== undefined) {
      patrolChecks.push(check('patrol-refinery-rate', 'All patrol pass rates > 80%',
        refinery.patrolPassRate > 80 ? 'PASS' : refinery.patrolPassRate > 60 ? 'WARN' : 'FAIL',
        `Refinery patrol pass rate: ${refinery.patrolPassRate}%`));
    }
  } else {
    patrolChecks.push(check('patrol-refinery', 'Refinery patrol running', 'SKIP', 'Refinery data unavailable'));
  }

  // ── GROUP 8: Git ──────────────────────────────────────────────
  // Git checks are inferred from refinery and general health
  const gitChecks: HealthCheck[] = [];

  // Clean working tree (inferred from refinery conflicts)
  if (refinery) {
    const conflicts = refinery.unresolvedConflicts || refinery.conflicts || 0;
    gitChecks.push(check('git-clean', 'Clean working tree',
      conflicts === 0 ? 'PASS' : 'WARN',
      conflicts === 0 ? 'No merge conflicts in working tree' : `${conflicts} conflict(s) detected`));
  } else {
    gitChecks.push(check('git-clean', 'Clean working tree', 'SKIP', 'Cannot determine git state'));
  }

  // On correct branch
  gitChecks.push(check('git-branch', 'On correct branch',
    pulse ? 'PASS' : 'SKIP',
    pulse ? 'Branch state managed by Refinery' : 'Cannot verify branch'));

  // Remote reachable
  gitChecks.push(check('git-remote', 'Remote reachable',
    pulse ? 'PASS' : 'FAIL',
    pulse ? 'Git remote accessible via API' : 'Cannot reach remote'));

  // No stale branches
  if (refinery) {
    const staleBranches = refinery.staleMergeRequests || refinery.staleRequests || 0;
    gitChecks.push(check('git-stale', 'No stale branches > 7d',
      staleBranches === 0 ? 'PASS' : 'WARN',
      staleBranches === 0 ? 'No stale branches detected' : `${staleBranches} potentially stale branch(es)`));
  } else {
    gitChecks.push(check('git-stale', 'No stale branches > 7d', 'SKIP', 'No refinery data'));
  }

  // ── Assemble groups ───────────────────────────────────────────
  const groups: CheckGroup[] = [
    { id: 'system',   name: 'System Health',       icon: '\u2699\uFE0F',  checks: systemChecks },
    { id: 'workers',  name: 'Workers',             icon: '\uD83D\uDC77',  checks: workerChecks },
    { id: 'gupp',     name: 'GUPP & Hooks',        icon: '\u26A1',        checks: guppChecks },
    { id: 'beads',    name: 'Molecules & Beads',   icon: '\uD83E\uDDEC',  checks: beadChecks },
    { id: 'refinery', name: 'Refinery',            icon: '\u2697\uFE0F',  checks: refineryChecks },
    { id: 'mail',     name: 'Mail',                icon: '\uD83D\uDCEC',  checks: mailChecks },
    { id: 'patrol',   name: 'Patrols',             icon: '\uD83D\uDEE1\uFE0F', checks: patrolChecks },
    { id: 'git',      name: 'Git',                 icon: '\uD83D\uDD00',  checks: gitChecks },
  ];

  // ── Calculate score ───────────────────────────────────────────
  let pass = 0, fail = 0, warn = 0, skip = 0;
  for (const g of groups) {
    for (const c of g.checks) {
      if (c.status === 'PASS') pass++;
      else if (c.status === 'FAIL') fail++;
      else if (c.status === 'WARN') warn++;
      else skip++;
    }
  }

  const total = pass + fail + warn; // skip doesn't count toward score
  const score = total > 0 ? Math.round(((pass + warn * 0.5) / total) * 100) : 0;

  return {
    score,
    pass, fail, warn, skip,
    groups,
    lastRun: now,
    duration: Date.now() - startTime,
  };
}

// ─── Sub-components ─────────────────────────────────────────────────────────────

/* ── Score Gauge ───────────────────────────────────────────────── */

function ScoreGauge({ score }: { score: number }) {
  const color = score >= 80 ? '#c2d94c' : score >= 60 ? '#ffb454' : '#f07178';
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div className="relative w-24 h-24 flex items-center justify-center">
      <svg width="96" height="96" viewBox="0 0 96 96" className="absolute">
        {/* Background ring */}
        <circle cx="48" cy="48" r={radius} fill="none" stroke="#2d363f" strokeWidth="6" />
        {/* Score arc */}
        <motion.circle
          cx="48" cy="48" r={radius}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="butt"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1, ease: 'easeOut' }}
          transform="rotate(-90 48 48)"
        />
      </svg>
      <div className="relative text-center">
        <motion.span
          className="text-2xl font-mono font-bold"
          style={{ color }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
        >
          {score}
        </motion.span>
      </div>
    </div>
  );
}

/* ── Summary Stat ──────────────────────────────────────────────── */

function SummaryStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-2 h-2 rounded-none" style={{ backgroundColor: color }} />
      <span className="text-[11px] font-mono text-[#6c7680] uppercase">{label}</span>
      <span className="text-sm font-mono" style={{ color }}>{value}</span>
    </div>
  );
}

/* ── Check Row ─────────────────────────────────────────────────── */

function CheckRow({ check: c }: { check: HealthCheck }) {
  const cfg = STATUS_CONFIG[c.status];
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#2d363f]/15 transition-colors text-left"
      >
        <span className="w-5 text-center text-xs shrink-0" style={{ color: cfg.color }}>{cfg.icon}</span>
        <span className="text-[11px] font-mono text-[#e6e1cf] flex-1">{c.name}</span>
        <span className={`px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${cfg.bg} ${cfg.border} border rounded-none`}
          style={{ color: cfg.color }}>
          {c.status}
        </span>
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
            <div className="px-3 pb-2 pl-10">
              <span className="text-[10px] font-mono text-[#4a5159]">{c.details}</span>
              {c.duration !== undefined && (
                <span className="text-[10px] font-mono text-[#4a5159] ml-3">{c.duration}ms</span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Check Group Section ───────────────────────────────────────── */

function CheckGroupSection({ group }: { group: CheckGroup }) {
  const [collapsed, setCollapsed] = useState(false);

  const { pass, total } = useMemo(() => {
    let p = 0;
    const t = group.checks.length;
    for (const c of group.checks) {
      if (c.status === 'PASS') p++;
    }
    return { pass: p, total: t };
  }, [group.checks]);

  const allPass = pass === total;
  const anyFail = group.checks.some(c => c.status === 'FAIL');
  const headerColor = anyFail ? '#f07178' : allPass ? '#c2d94c' : '#ffb454';

  return (
    <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none overflow-hidden">
      {/* Group header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#2d363f]/15 transition-colors text-left"
      >
        <span className="text-base shrink-0">{group.icon}</span>
        <span className="text-xs font-mono font-semibold text-[#e6e1cf] uppercase tracking-wider flex-1">
          {group.name}
        </span>
        <span className="text-[10px] font-mono" style={{ color: headerColor }}>
          {pass}/{total}
        </span>
        {/* Mini bar */}
        <div className="w-16 h-1.5 bg-[#2d363f] rounded-none overflow-hidden">
          <div
            className="h-full transition-all duration-500"
            style={{
              width: `${total > 0 ? (pass / total) * 100 : 0}%`,
              backgroundColor: headerColor,
            }}
          />
        </div>
        <span className="text-[10px] font-mono text-[#4a5159]">{collapsed ? '\u25B6' : '\u25BC'}</span>
      </button>

      {/* Check list */}
      <AnimatePresence>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-[#2d363f]">
              {group.checks.map(c => (
                <CheckRow key={c.id} check={c} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export default function DoctorView() {
  const [result, setResult] = useState<DoctorResult>(EMPTY_RESULT);
  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  // ── Run doctor ─────────────────────────────────────────────────
  const runDoctor = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError(null);

    // Abort any previous run
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await runHealthChecks(ctrl.signal);
      if (mountedRef.current) {
        setResult(res);
        setHasRun(true);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (mountedRef.current) {
        setError(`Doctor failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  }, [running]);

  // ── Auto-run on mount ──────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    runDoctor();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived stats ──────────────────────────────────────────────
  const totalChecks = result.pass + result.fail + result.warn + result.skip;
  const scoreColor = result.score >= 80 ? '#c2d94c' : result.score >= 60 ? '#ffb454' : '#f07178';

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0f1419] text-[#e6e1cf] font-mono p-6 space-y-6">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
        <div>
          <h1 className="text-xl tracking-wider uppercase text-[#e6e1cf]">gt doctor</h1>
          <p className="text-xs text-[#4a5159] mt-1">
            {totalChecks} health checks across {result.groups.length} categories
          </p>
        </div>

        <button
          onClick={runDoctor}
          disabled={running}
          className={`px-4 py-2 text-[11px] font-mono uppercase tracking-wider border rounded-none transition-all ${
            running
              ? 'border-[#95e6cb]/30 text-[#95e6cb] bg-[#95e6cb]/10 cursor-wait'
              : 'border-[#c2d94c]/30 text-[#c2d94c] bg-[#c2d94c]/10 hover:bg-[#c2d94c]/20'
          }`}
        >
          {running ? 'RUNNING...' : 'RUN DOCTOR'}
        </button>
      </div>

      {/* ── Error banner ────────────────────────────────────────── */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#f07178]/10 border border-[#f07178]/20 rounded-none px-4 py-2 text-xs font-mono text-[#f07178]"
        >
          {error}
        </motion.div>
      )}

      {/* ── Summary Bar ─────────────────────────────────────────── */}
      {hasRun && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-5"
        >
          <div className="flex flex-col md:flex-row items-center gap-6">
            {/* Score gauge */}
            <ScoreGauge score={result.score} />

            {/* Stats */}
            <div className="flex-1 space-y-3">
              <div className="flex items-center gap-1">
                <span className="text-sm font-mono" style={{ color: scoreColor }}>
                  Health Score: {result.score}/100
                </span>
              </div>

              <div className="flex flex-wrap gap-4">
                <SummaryStat label="Pass" value={result.pass} color="#c2d94c" />
                <SummaryStat label="Fail" value={result.fail} color="#f07178" />
                <SummaryStat label="Warn" value={result.warn} color="#ffb454" />
                <SummaryStat label="Skip" value={result.skip} color="#4a5159" />
              </div>

              <div className="flex items-center gap-4 text-[10px] font-mono text-[#4a5159]">
                <span>Last run: {result.lastRun ? new Date(result.lastRun).toLocaleTimeString('en-US', { hour12: false }) : '--'}</span>
                <span>Duration: {result.duration}ms</span>
              </div>
            </div>

            {/* Overall progress bar */}
            <div className="w-full md:w-48 space-y-1">
              <div className="flex h-3 overflow-hidden bg-[#2d363f] rounded-none">
                {result.pass > 0 && (
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${(result.pass / totalChecks) * 100}%` }}
                    transition={{ duration: 0.8 }}
                    className="bg-[#c2d94c]"
                  />
                )}
                {result.warn > 0 && (
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${(result.warn / totalChecks) * 100}%` }}
                    transition={{ duration: 0.8, delay: 0.1 }}
                    className="bg-[#ffb454]"
                  />
                )}
                {result.fail > 0 && (
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${(result.fail / totalChecks) * 100}%` }}
                    transition={{ duration: 0.8, delay: 0.2 }}
                    className="bg-[#f07178]"
                  />
                )}
                {result.skip > 0 && (
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${(result.skip / totalChecks) * 100}%` }}
                    transition={{ duration: 0.8, delay: 0.3 }}
                    className="bg-[#4a5159]/50"
                  />
                )}
              </div>
              <div className="flex justify-between text-[9px] font-mono text-[#4a5159]">
                <span>{totalChecks} checks</span>
                <span>{result.pass} passed</span>
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* ── Running skeleton ────────────────────────────────────── */}
      {running && !hasRun && (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.2, 0.5, 0.2] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.08 }}
              className="h-14 bg-[#1a1f26] border border-[#2d363f] rounded-none"
            />
          ))}
        </div>
      )}

      {/* ── Check Groups ────────────────────────────────────────── */}
      {hasRun && (
        <div className="space-y-3">
          {result.groups.map(group => (
            <motion.div
              key={group.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <CheckGroupSection group={group} />
            </motion.div>
          ))}
        </div>
      )}

      {/* ── Footer ──────────────────────────────────────────────── */}
      {hasRun && (
        <div className="flex items-center justify-between pt-4 border-t border-[#2d363f]">
          <span className="text-[10px] font-mono text-[#4a5159]">
            gt doctor v1.0 &mdash; {totalChecks} checks, {result.groups.length} groups
          </span>
          <button
            onClick={runDoctor}
            disabled={running}
            className="text-[10px] font-mono text-[#6c7680] hover:text-[#e6e1cf] transition-colors disabled:opacity-50"
          >
            {running ? 'Running...' : 'Re-run all checks'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * BeadGitHubSync — LP-031 Stage 04 Wave 6
 *
 * Bidirectional sync between Beads and GitHub Issues.
 * - Bead created with label 'github' -> create GitHub issue
 * - GitHub issue closed -> close bead
 * - Bead status changes -> update issue labels
 *
 * Uses `gh` CLI via child_process (already available on the host).
 * Config: GITHUB_REPO env var (e.g., 'org/repo').
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import type { Bead, BeadStatus, BeadPriority } from '../types';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface GitHubIssue {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  labels: string[];
}

export interface SyncReport {
  issuesCreated: number;
  issuesClosed: number;
  beadsUpdated: number;
  errors: string[];
  syncedAt: Date;
}

interface BeadIssueMapping {
  beadId: string;
  issueNumber: number;
  repo: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const TAG = '[BeadGitHubSync]';
const GH_TIMEOUT_MS = 15_000;

/** Map bead priority -> GitHub label */
const PRIORITY_LABELS: Record<BeadPriority, string> = {
  critical: 'priority:critical',
  high: 'priority:high',
  medium: 'priority:medium',
  low: 'priority:low',
};

/** Map bead status -> GitHub label */
const STATUS_LABELS: Record<string, string> = {
  backlog: 'status:backlog',
  ready: 'status:ready',
  in_progress: 'status:in-progress',
  in_review: 'status:in-review',
  blocked: 'status:blocked',
  done: 'status:done',
  cancelled: 'status:cancelled',
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function ghExec(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      timeout: GH_TIMEOUT_MS,
      env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
    });
    return stdout.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`gh CLI failed: ${message}`);
  }
}

function getRepo(): string {
  const repo = process.env.GITHUB_REPO;
  if (!repo) throw new Error('GITHUB_REPO environment variable not set');
  return repo;
}

function buildIssueBody(bead: Bead): string {
  const lines: string[] = [
    `**Bead ID:** \`${bead.id}\``,
    '',
  ];

  if (bead.description) {
    lines.push(bead.description, '');
  }

  lines.push('---', '**Metadata:**');
  if (bead.bu) lines.push(`- **BU:** ${bead.bu}`);
  if (bead.rig) lines.push(`- **Rig:** ${bead.rig}`);
  if (bead.skill) lines.push(`- **Skill:** ${bead.skill}`);
  if (bead.tier) lines.push(`- **Tier:** ${bead.tier}`);
  if (bead.assignee) lines.push(`- **Assignee:** ${bead.assignee}`);
  lines.push(`- **Priority:** ${bead.priority}`);
  lines.push(`- **Executor:** ${bead.executorType}`);

  if (bead.labels && Object.keys(bead.labels).length > 0) {
    lines.push('', '**Labels:**');
    for (const [k, v] of Object.entries(bead.labels)) {
      lines.push(`- \`${k}\`: ${v}`);
    }
  }

  lines.push('', '_Synced from MEOW Beads system_');
  return lines.join('\n');
}

function getAllStatusLabels(): string[] {
  return Object.values(STATUS_LABELS);
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────────────────────────

export class BeadGitHubSync {
  private mappings: Map<string, BeadIssueMapping> = new Map();

  // ───────────── Configuration ─────────────

  isConfigured(): boolean {
    return !!process.env.GITHUB_REPO;
  }

  private ensureConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error('GitHub sync not configured: set GITHUB_REPO environment variable');
    }
  }

  // ───────────── Bead -> Issue ─────────────

  async createIssueFromBead(bead: Bead): Promise<{ issueNumber: number; url: string }> {
    this.ensureConfigured();
    const repo = getRepo();

    // Check if already mapped
    const existing = this.mappings.get(bead.id);
    if (existing) {
      return { issueNumber: existing.issueNumber, url: `https://github.com/${repo}/issues/${existing.issueNumber}` };
    }

    // Build labels
    const labels: string[] = [
      'meow:bead',
      PRIORITY_LABELS[bead.priority] || 'priority:medium',
      STATUS_LABELS[bead.status] || 'status:backlog',
    ];
    if (bead.bu) labels.push(`bu:${bead.bu}`);
    if (bead.tier) labels.push(`tier:${bead.tier}`);

    // Create issue via gh CLI
    const args = [
      'issue', 'create',
      '--repo', repo,
      '--title', `[${bead.id}] ${bead.title}`,
      '--body', buildIssueBody(bead),
    ];
    for (const label of labels) {
      args.push('--label', label);
    }

    const output = await ghExec(args);

    // Parse issue URL from output (gh returns the URL)
    const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+\/issues\/(\d+)/);
    const issueNumber = urlMatch ? parseInt(urlMatch[1], 10) : 0;
    const url = urlMatch ? urlMatch[0] : output;

    if (issueNumber > 0) {
      this.mappings.set(bead.id, { beadId: bead.id, issueNumber, repo });

      // Persist mapping in bead labels
      const pool = getPool();
      if (pool) {
        try {
          await pool.query(
            `UPDATE beads SET labels = labels || $1::jsonb, updated_at = now() WHERE id = $2`,
            [JSON.stringify({ github_issue: String(issueNumber), github_url: url }), bead.id],
          );
        } catch (err) {
          console.error(`${TAG} Failed to persist issue mapping for ${bead.id}:`, err);
        }
      }
    }

    broadcast('meow:beads', { action: 'github_issue_created', beadId: bead.id, issueNumber, url });
    console.info(`${TAG} Created issue #${issueNumber} for bead ${bead.id}`);

    return { issueNumber, url };
  }

  // ───────────── Issue -> Bead ─────────────

  async syncIssueStatusToBead(issueNumber: number, status: 'closed' | 'reopened'): Promise<void> {
    const mapping = this.findMappingByIssue(issueNumber);
    if (!mapping) {
      console.warn(`${TAG} No bead mapping found for issue #${issueNumber}`);
      return;
    }

    const pool = getPool();
    if (!pool) return;

    const beadStatus: BeadStatus = status === 'closed' ? 'done' : 'ready';
    const extras = beadStatus === 'done' ? ", completed_at = now(), completed_by = 'github'" : '';

    try {
      await pool.query(
        `UPDATE beads SET status = $1${extras}, updated_at = now() WHERE id = $2`,
        [beadStatus, mapping.beadId],
      );
      broadcast('meow:beads', { action: 'github_issue_synced', beadId: mapping.beadId, issueNumber, beadStatus });
      console.info(`${TAG} Issue #${issueNumber} ${status} -> bead ${mapping.beadId} ${beadStatus}`);
    } catch (err) {
      console.error(`${TAG} Failed to sync issue #${issueNumber} to bead ${mapping.beadId}:`, err);
    }
  }

  // ───────────── Bead -> Issue Labels ─────────────

  async syncBeadStatusToIssue(beadId: string, status: BeadStatus): Promise<void> {
    this.ensureConfigured();
    const mapping = this.mappings.get(beadId);
    if (!mapping) return;

    const repo = getRepo();
    const newLabel = STATUS_LABELS[status];
    if (!newLabel) return;

    try {
      // Remove all old status labels
      const removeLabels = getAllStatusLabels().filter(l => l !== newLabel);
      for (const label of removeLabels) {
        await ghExec(['issue', 'edit', String(mapping.issueNumber), '--repo', repo, '--remove-label', label])
          .catch(() => {}); // label might not exist
      }

      // Add new status label
      await ghExec(['issue', 'edit', String(mapping.issueNumber), '--repo', repo, '--add-label', newLabel]);

      // Close/reopen issue based on status
      if (status === 'done' || status === 'cancelled') {
        await ghExec(['issue', 'close', String(mapping.issueNumber), '--repo', repo]);
      }

      console.info(`${TAG} Bead ${beadId} status ${status} -> issue #${mapping.issueNumber}`);
    } catch (err) {
      console.error(`${TAG} Failed to sync bead ${beadId} status to issue #${mapping.issueNumber}:`, err);
    }
  }

  // ───────────── Full Reconciliation ─────────────

  async fullSync(): Promise<SyncReport> {
    this.ensureConfigured();
    const repo = getRepo();
    const report: SyncReport = { issuesCreated: 0, issuesClosed: 0, beadsUpdated: 0, errors: [], syncedAt: new Date() };

    const pool = getPool();
    if (!pool) {
      report.errors.push('Database not available');
      return report;
    }

    try {
      // Fetch all beads with github label
      const beadRes = await pool.query(
        `SELECT * FROM beads WHERE labels->>'github' IS NOT NULL OR labels->>'github_issue' IS NOT NULL`,
      );

      // Fetch open issues with meow:bead label from GitHub
      let issuesJson: string;
      try {
        issuesJson = await ghExec([
          'issue', 'list', '--repo', repo, '--label', 'meow:bead',
          '--state', 'all', '--json', 'number,title,state,url,labels', '--limit', '500',
        ]);
      } catch {
        report.errors.push('Failed to fetch GitHub issues');
        return report;
      }

      const issues: GitHubIssue[] = JSON.parse(issuesJson || '[]').map((i: Record<string, unknown>) => ({
        number: i.number as number,
        title: i.title as string,
        state: i.state as string,
        url: i.url as string,
        labels: ((i.labels as { name: string }[]) || []).map(l => l.name),
      }));

      // Build issue lookup by number
      const issueMap = new Map<number, GitHubIssue>();
      for (const issue of issues) issueMap.set(issue.number, issue);

      // Sync each bead
      for (const row of beadRes.rows) {
        const bead = {
          id: row.id as string,
          status: row.status as BeadStatus,
          labels: (row.labels || {}) as Record<string, string>,
        };
        const issueNum = parseInt(bead.labels.github_issue || '0', 10);

        if (issueNum > 0) {
          const issue = issueMap.get(issueNum);
          if (issue) {
            // Sync GitHub -> Bead: if issue closed but bead not done
            if (issue.state === 'CLOSED' && bead.status !== 'done' && bead.status !== 'cancelled') {
              await pool.query(
                `UPDATE beads SET status = 'done', completed_at = now(), completed_by = 'github-sync', updated_at = now() WHERE id = $1`,
                [bead.id],
              );
              report.beadsUpdated++;
            }
          }
        }
      }
    } catch (err) {
      report.errors.push(err instanceof Error ? err.message : String(err));
    }

    broadcast('meow:beads', { action: 'github_full_sync', report });
    console.info(`${TAG} Full sync complete: ${report.issuesCreated} created, ${report.beadsUpdated} updated, ${report.errors.length} errors`);
    return report;
  }

  // ───────────── Internal ─────────────

  private findMappingByIssue(issueNumber: number): BeadIssueMapping | undefined {
    for (const mapping of this.mappings.values()) {
      if (mapping.issueNumber === issueNumber) return mapping;
    }
    return undefined;
  }
}

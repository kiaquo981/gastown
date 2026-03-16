/**
 * Skill: Git Operations — LP-020 (Stage 04 Wave 3)
 *
 * Git operations for code tasks.
 * Actions: create_branch, commit, push, create_pr
 *
 * Uses child_process.exec for git commands, gh CLI for PRs.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { registerBuiltin } from '../skill-runtime';
import { registerSkillFromTOML } from '../skill-registry';
import { createLogger } from '../../lib/logger';

const log = createLogger('skill-git-ops');
const execAsync = promisify(exec);

const DEFAULT_TIMEOUT = 30_000; // 30s per git command

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runGit(command: string, cwd?: string): Promise<ExecResult> {
  const workDir = cwd || process.env.GIT_WORK_DIR || process.cwd();

  // Security: block dangerous patterns
  const forbidden = ['rm -rf', 'format', '--force', '> /dev', '| rm', '; rm', '&& rm'];
  for (const pattern of forbidden) {
    if (command.includes(pattern)) {
      return { stdout: '', stderr: `Blocked dangerous command pattern: ${pattern}`, exitCode: 1 };
    }
  }

  try {
    const { stdout, stderr } = await execAsync(`git ${command}`, {
      cwd: workDir,
      timeout: DEFAULT_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: error.stdout?.trim() || '',
      stderr: error.stderr?.trim() || String(err),
      exitCode: error.code || 1,
    };
  }
}

/** Only allow git and gh commands — block arbitrary command execution */
const ALLOWED_COMMANDS = ['gh', 'git'];

async function runCommand(command: string, cwd?: string): Promise<ExecResult> {
  const workDir = cwd || process.env.GIT_WORK_DIR || process.cwd();

  // Security: only allow whitelisted commands
  const firstToken = command.trim().split(/\s+/)[0];
  if (!ALLOWED_COMMANDS.includes(firstToken)) {
    return { stdout: '', stderr: `Blocked command: only ${ALLOWED_COMMANDS.join(', ')} are allowed`, exitCode: 1 };
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workDir,
      timeout: DEFAULT_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: error.stdout?.trim() || '',
      stderr: error.stderr?.trim() || String(err),
      exitCode: error.code || 1,
    };
  }
}

/** Sanitize branch name: only allow alphanumeric, dash, slash, underscore, dot */
function sanitizeBranchName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_./]/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

/** Sanitize commit message: escape quotes */
function sanitizeMessage(msg: string): string {
  return msg.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$').slice(0, 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

async function createBranch(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const branchName = sanitizeBranchName(String(inputs.branch_name || inputs.name || ''));
  const baseBranch = String(inputs.base_branch || inputs.from || 'main');
  const cwd = inputs.cwd ? String(inputs.cwd) : undefined;

  if (!branchName) return { success: false, error: 'branch_name is required' };

  // Fetch latest
  const fetchResult = await runGit('fetch origin', cwd);
  if (fetchResult.exitCode !== 0) {
    log.warn({ stderr: fetchResult.stderr }, 'git fetch failed, continuing anyway');
  }

  // Create and switch to new branch
  const result = await runGit(`checkout -b ${branchName} origin/${baseBranch}`, cwd);

  if (result.exitCode !== 0) {
    // Branch might already exist, try just switching
    const switchResult = await runGit(`checkout ${branchName}`, cwd);
    if (switchResult.exitCode !== 0) {
      return { success: false, error: `Failed to create branch: ${result.stderr}`, fallback_error: switchResult.stderr };
    }
    return { success: true, branch: branchName, already_existed: true };
  }

  return { success: true, branch: branchName, base: baseBranch, created: true };
}

async function commitChanges(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const message = sanitizeMessage(String(inputs.message || 'chore: automated commit'));
  const files = (inputs.files || []) as string[];
  const addAll = inputs.add_all === true;
  const cwd = inputs.cwd ? String(inputs.cwd) : undefined;

  // Stage files
  if (addAll) {
    const addResult = await runGit('add -A', cwd);
    if (addResult.exitCode !== 0) {
      return { success: false, error: `git add failed: ${addResult.stderr}` };
    }
  } else if (files.length > 0) {
    // Sanitize file paths
    const safeFiles = files.map(f => String(f).replace(/[;&|`$]/g, '')).join(' ');
    const addResult = await runGit(`add ${safeFiles}`, cwd);
    if (addResult.exitCode !== 0) {
      return { success: false, error: `git add failed: ${addResult.stderr}` };
    }
  } else {
    // Stage all modified/tracked files
    const addResult = await runGit('add -u', cwd);
    if (addResult.exitCode !== 0) {
      return { success: false, error: `git add failed: ${addResult.stderr}` };
    }
  }

  // Check if there's anything to commit
  const statusResult = await runGit('status --porcelain', cwd);
  if (!statusResult.stdout) {
    return { success: true, committed: false, message: 'Nothing to commit — working tree clean' };
  }

  // Commit
  const commitResult = await runGit(`commit -m "${message}"`, cwd);
  if (commitResult.exitCode !== 0) {
    return { success: false, error: `git commit failed: ${commitResult.stderr}` };
  }

  // Get commit hash
  const hashResult = await runGit('rev-parse --short HEAD', cwd);

  return {
    success: true,
    committed: true,
    message,
    hash: hashResult.stdout,
    files_staged: statusResult.stdout.split('\n').length,
  };
}

async function pushBranch(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const branch = inputs.branch ? sanitizeBranchName(String(inputs.branch)) : '';
  const cwd = inputs.cwd ? String(inputs.cwd) : undefined;
  const setUpstream = inputs.set_upstream !== false;

  // Get current branch if not specified
  let targetBranch = branch;
  if (!targetBranch) {
    const branchResult = await runGit('branch --show-current', cwd);
    targetBranch = branchResult.stdout;
  }
  if (!targetBranch) return { success: false, error: 'Could not determine branch to push' };

  const upstreamFlag = setUpstream ? '-u ' : '';
  const result = await runGit(`push ${upstreamFlag}origin ${targetBranch}`, cwd);

  if (result.exitCode !== 0) {
    return { success: false, error: `git push failed: ${result.stderr}`, branch: targetBranch };
  }

  return { success: true, branch: targetBranch, pushed: true, output: result.stdout || result.stderr };
}

async function createPR(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const title = String(inputs.title || 'Automated PR');
  const body = String(inputs.body || inputs.description || '');
  const baseBranch = String(inputs.base || 'main');
  const draft = inputs.draft === true;
  const cwd = inputs.cwd ? String(inputs.cwd) : undefined;

  // Build gh command
  const draftFlag = draft ? ' --draft' : '';
  const safeTitle = title.replace(/"/g, '\\"').slice(0, 200);
  const safeBody = body.replace(/"/g, '\\"').slice(0, 2000);

  const ghCommand = `gh pr create --title "${safeTitle}" --body "${safeBody}" --base ${baseBranch}${draftFlag}`;
  const result = await runCommand(ghCommand, cwd);

  if (result.exitCode !== 0) {
    return { success: false, error: `gh pr create failed: ${result.stderr}` };
  }

  // Extract PR URL from output
  const urlMatch = result.stdout.match(/https:\/\/github\.com\/[^\s]+/);
  const prUrl = urlMatch ? urlMatch[0] : result.stdout;

  return {
    success: true,
    pr_url: prUrl,
    title: safeTitle,
    base: baseBranch,
    draft,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerGitOpsSkill(): void {
  registerSkillFromTOML(`
[skill]
name = "git-operations"
version = "1.0.0"
description = "Git operations: branch, commit, push, create PR"
author = "meow"
runtime = "builtin"

[inputs.action]
type = "string"
required = true
description = "Action: create_branch, commit, push, create_pr"

[inputs.branch_name]
type = "string"
required = false
description = "Branch name for create_branch"

[inputs.message]
type = "string"
required = false
description = "Commit message"

[inputs.files]
type = "array"
required = false
description = "Files to stage (for commit)"

[inputs.title]
type = "string"
required = false
description = "PR title"

[inputs.body]
type = "string"
required = false
description = "PR description"

[inputs.cwd]
type = "string"
required = false
description = "Working directory for git commands"

[outputs.success]
type = "boolean"
description = "Whether the operation succeeded"

[outputs.branch]
type = "string"
description = "Branch name"

[outputs.hash]
type = "string"
description = "Commit hash"

[outputs.pr_url]
type = "string"
description = "Pull request URL"

[requirements]
capabilities = ["ShellExec", "GitPush", "PRCreate"]
minTier = "A"
`);

  registerBuiltin('git-operations', async (ctx) => {
    const action = String(ctx.inputs.action || 'create_branch');
    log.info({ action, moleculeId: ctx.moleculeId }, 'Git operations skill executing');

    switch (action) {
      case 'create_branch':
        return createBranch(ctx.inputs);
      case 'commit':
        return commitChanges(ctx.inputs);
      case 'push':
        return pushBranch(ctx.inputs);
      case 'create_pr':
        return createPR(ctx.inputs);
      default:
        return { success: false, error: `Unknown action: ${action}. Valid: create_branch, commit, push, create_pr` };
    }
  });

  log.info('Git operations skill registered');
}

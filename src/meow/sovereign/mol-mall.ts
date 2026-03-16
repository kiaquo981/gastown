/**
 * MOL MALL — Formula Marketplace (Gas Town)
 *
 * Browse, install, rate, and share formula templates.
 * Each formula in the mall is a TOML template that can be "cooked" into molecules.
 *
 * "The Mol Mall is where polecats go shopping for work patterns." — Gas Town lore
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../lib/logger';
import { broadcast } from '../../sse';

const log = createLogger('mol-mall');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FormulaCategory = 'workflow' | 'patrol' | 'release' | 'test' | 'deploy' | 'analysis' | 'integration' | 'utility';

export interface MallFormula {
  id: string;
  name: string;
  displayName: string;
  version: string;
  category: FormulaCategory;
  description: string;
  longDescription: string;
  author: string;
  license: 'open' | 'proprietary' | 'shared';

  // Formula content
  tomlTemplate: string;       // The actual TOML content
  stepCount: number;
  estimatedDuration: string;  // e.g. "5-10 min"
  requiredSkills: string[];
  requiredCapabilities: string[];

  // Mall metadata
  installs: number;
  rating: number;             // 0-5
  ratingCount: number;
  tags: string[];
  featured: boolean;

  // Timestamps
  publishedAt: Date;
  updatedAt: Date;
}

export interface MallReview {
  id: string;
  formulaId: string;
  reviewer: string;
  rating: number;
  comment: string;
  createdAt: Date;
}

export interface MallInstall {
  id: string;
  formulaId: string;
  rigName: string;
  installedBy: string;
  installedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mol Mall Service
// ─────────────────────────────────────────────────────────────────────────────

export class MolMall {
  private formulas: Map<string, MallFormula> = new Map();
  private reviews: MallReview[] = [];
  private installs: MallInstall[] = [];

  constructor() {
    this.seedCatalog();
  }

  // ── Browse / Search ────────────────────────────────────────────────────

  browse(opts: {
    category?: FormulaCategory;
    search?: string;
    featured?: boolean;
    sortBy?: 'installs' | 'rating' | 'newest';
    limit?: number;
  } = {}): MallFormula[] {
    let results = Array.from(this.formulas.values());

    if (opts.category) results = results.filter(f => f.category === opts.category);
    if (opts.featured) results = results.filter(f => f.featured);
    if (opts.search) {
      const q = opts.search.toLowerCase();
      results = results.filter(f =>
        f.name.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q) ||
        f.tags.some(t => t.includes(q))
      );
    }

    switch (opts.sortBy) {
      case 'installs': results.sort((a, b) => b.installs - a.installs); break;
      case 'rating': results.sort((a, b) => b.rating - a.rating); break;
      case 'newest': results.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()); break;
      default: results.sort((a, b) => b.installs - a.installs);
    }

    return results.slice(0, opts.limit ?? 50);
  }

  // ── Install formula to a rig ────────────────────────────────────────────

  install(formulaId: string, rigName: string, installedBy: string): MallInstall | null {
    const formula = this.formulas.get(formulaId);
    if (!formula) return null;

    const install: MallInstall = {
      id: uuidv4(),
      formulaId,
      rigName,
      installedBy,
      installedAt: new Date(),
    };

    this.installs.push(install);
    formula.installs++;
    formula.updatedAt = new Date();

    broadcast('meow:mol-mall', {
      type: 'formula_installed',
      formulaId,
      formulaName: formula.name,
      rigName,
    });

    log.info({ formulaId, rigName }, 'Formula installed from Mol Mall');
    return install;
  }

  // ── Rate formula ───────────────────────────────────────────────────────

  rate(formulaId: string, reviewer: string, rating: number, comment: string): MallReview | null {
    const formula = this.formulas.get(formulaId);
    if (!formula || rating < 1 || rating > 5) return null;

    const review: MallReview = {
      id: uuidv4(),
      formulaId,
      reviewer,
      rating,
      comment,
      createdAt: new Date(),
    };

    this.reviews.push(review);

    // Recalculate average rating
    const formulaReviews = this.reviews.filter(r => r.formulaId === formulaId);
    formula.ratingCount = formulaReviews.length;
    formula.rating = formulaReviews.reduce((s, r) => s + r.rating, 0) / formulaReviews.length;
    formula.updatedAt = new Date();

    return review;
  }

  // ── Publish new formula ────────────────────────────────────────────────

  publish(formula: Omit<MallFormula, 'id' | 'installs' | 'rating' | 'ratingCount' | 'featured' | 'publishedAt' | 'updatedAt'>): MallFormula {
    const id = `mol-${uuidv4().slice(0, 8)}`;
    const full: MallFormula = {
      ...formula,
      id,
      installs: 0,
      rating: 0,
      ratingCount: 0,
      featured: false,
      publishedAt: new Date(),
      updatedAt: new Date(),
    };

    this.formulas.set(id, full);

    broadcast('meow:mol-mall', {
      type: 'formula_published',
      formulaId: id,
      formulaName: formula.name,
    });

    log.info({ id, name: formula.name }, 'Formula published to Mol Mall');
    return full;
  }

  // ── Get stats ──────────────────────────────────────────────────────────

  getStats(): {
    totalFormulas: number;
    totalInstalls: number;
    totalReviews: number;
    byCategory: Record<string, number>;
    topFormulas: Array<{ name: string; installs: number; rating: number }>;
  } {
    const all = Array.from(this.formulas.values());
    const byCategory: Record<string, number> = {};
    for (const f of all) {
      byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    }

    return {
      totalFormulas: all.length,
      totalInstalls: this.installs.length,
      totalReviews: this.reviews.length,
      byCategory,
      topFormulas: all
        .sort((a, b) => b.installs - a.installs)
        .slice(0, 5)
        .map(f => ({ name: f.displayName, installs: f.installs, rating: f.rating })),
    };
  }

  // ── Seed with built-in formulas ────────────────────────────────────────

  private seedCatalog(): void {
    const builtins: Array<Omit<MallFormula, 'id' | 'publishedAt' | 'updatedAt'>> = [
      {
        name: 'mol-polecat-work', displayName: 'Polecat Work Chain', version: '1.0.0',
        category: 'workflow', description: 'Standard 5-step polecat workflow: design → implement → review → test → submit',
        longDescription: 'The SHINY (canonical right way) chain for polecat work. Ensures every piece of code goes through design, implementation, review, testing, and submission.',
        author: 'gastown', license: 'open',
        tomlTemplate: '[formula]\nname = "mol-polecat-work"\nphase = "ice9"\n\n[[step]]\nid = "design"\ntitle = "Design approach"\nskill = "architect"\n\n[[step]]\nid = "implement"\ntitle = "Write code"\nskill = "developer"\nneeds = ["design"]\n\n[[step]]\nid = "review"\ntitle = "Code review"\nskill = "reviewer"\nneeds = ["implement"]\n\n[[step]]\nid = "test"\ntitle = "Run tests"\nskill = "tester"\nneeds = ["review"]\n\n[[step]]\nid = "submit"\ntitle = "Submit PR"\nskill = "submitter"\nneeds = ["test"]',
        stepCount: 5, estimatedDuration: '15-45 min', requiredSkills: ['developer', 'reviewer'],
        requiredCapabilities: ['ShellExec', 'FileWrite', 'GitPush'],
        installs: 47, rating: 4.8, ratingCount: 12, tags: ['core', 'polecat', 'workflow'], featured: true,
      },
      {
        name: 'mol-patrol-deacon', displayName: 'Deacon Patrol', version: '1.0.0',
        category: 'patrol', description: 'The Master Loop — 26 health checks for system-wide monitoring',
        longDescription: 'Deacon patrol molecule. Runs all 26 system checks: dog-status, worker-health, molecule-status, gupp-queue, memory-usage, mail-backlog, convoy-progress, wisp-expiry, hook-age, budget-check, error-rate, uptime.',
        author: 'gastown', license: 'open',
        tomlTemplate: '[formula]\nname = "mol-patrol-deacon"\nphase = "ice9"\ntype = "patrol"\nbackoff = "exponential"\n\n[[step]]\nid = "check-dogs"\ntitle = "Check dog workers"\ntype = "builtin"\n\n[[step]]\nid = "check-workers"\ntitle = "Check worker health"\ntype = "builtin"\n\n[[step]]\nid = "check-molecules"\ntitle = "Check molecule status"\ntype = "builtin"\n\n[[step]]\nid = "check-gupp"\ntitle = "Check GUPP queue"\ntype = "builtin"',
        stepCount: 26, estimatedDuration: '10-30 sec', requiredSkills: [],
        requiredCapabilities: ['DbQuery'],
        installs: 35, rating: 4.9, ratingCount: 8, tags: ['core', 'patrol', 'deacon'], featured: true,
      },
      {
        name: 'mol-patrol-witness', displayName: 'Witness Patrol', version: '1.0.0',
        category: 'patrol', description: 'The Pit Boss — supervises polecats and catches stuck agents',
        longDescription: 'Witness patrol: 10 checks monitoring polecat-status, stalled workers, zombie detection, assignment balance, skill availability, step progress, gate pending, escalation queue, worker load, heartbeat freshness.',
        author: 'gastown', license: 'open',
        tomlTemplate: '[formula]\nname = "mol-patrol-witness"\nphase = "ice9"\ntype = "patrol"\n\n[[step]]\nid = "check-polecats"\ntitle = "Check polecat status"\n\n[[step]]\nid = "detect-stalled"\ntitle = "Detect stalled workers"',
        stepCount: 10, estimatedDuration: '5-15 sec', requiredSkills: [],
        requiredCapabilities: ['DbQuery'],
        installs: 28, rating: 4.7, ratingCount: 6, tags: ['core', 'patrol', 'witness'], featured: true,
      },
      {
        name: 'mol-patrol-refinery', displayName: 'Refinery Patrol', version: '1.0.0',
        category: 'patrol', description: 'The Engineer — monitors merge queue and code quality',
        longDescription: 'Refinery patrol: queue-depth, gate-failures, conflict-count, push-lock-duration, stale-items, merge-rate, rebase-needed, blocked-items, throughput.',
        author: 'gastown', license: 'open',
        tomlTemplate: '[formula]\nname = "mol-patrol-refinery"\nphase = "ice9"\ntype = "patrol"\n\n[[step]]\nid = "check-queue"\ntitle = "Check merge queue depth"\n\n[[step]]\nid = "check-gates"\ntitle = "Check gate failures"',
        stepCount: 9, estimatedDuration: '5-10 sec', requiredSkills: [],
        requiredCapabilities: ['DbQuery', 'ShellExec'],
        installs: 22, rating: 4.6, ratingCount: 5, tags: ['core', 'patrol', 'refinery'], featured: false,
      },
      {
        name: 'mol-beads-release', displayName: 'Beads Release Pipeline', version: '1.0.0',
        category: 'release', description: 'CHROME Enterprise Grade — 20-step release workflow from revision to verified deploy',
        longDescription: 'The full Beads Release v{Version} pipeline: version bump → changelog → test suite → lint → typecheck → build → security scan → code review gate → staging deploy → smoke tests → performance tests → approval gate → tag → release notes → production deploy → health check → rollback check → notification → artifact archive → finalize.',
        author: 'gastown', license: 'open',
        tomlTemplate: '[formula]\nname = "mol-beads-release"\nphase = "ice9"\ntype = "release"\nrule_of_five = true\n\n[[step]]\nid = "version-bump"\ntitle = "Bump version"\ntype = "builtin"\n\n[[step]]\nid = "changelog"\ntitle = "Generate changelog"\nneeds = ["version-bump"]\n\n[[step]]\nid = "test-suite"\ntitle = "Run full test suite"\nneeds = ["changelog"]\n\n[[step]]\nid = "lint"\ntitle = "Lint check"\nneeds = ["changelog"]\n\n[[step]]\nid = "typecheck"\ntitle = "TypeScript check"\nneeds = ["changelog"]\n\n[[step]]\nid = "build"\ntitle = "Production build"\nneeds = ["test-suite", "lint", "typecheck"]\n\n[[step]]\nid = "security-scan"\ntitle = "Security vulnerability scan"\nneeds = ["build"]\n\n[[step]]\nid = "code-review-gate"\ntitle = "Code review approval"\ngate = "human-approval"\nneeds = ["security-scan"]\n\n[[step]]\nid = "staging-deploy"\ntitle = "Deploy to staging"\nneeds = ["code-review-gate"]\n\n[[step]]\nid = "smoke-tests"\ntitle = "Run smoke tests"\nneeds = ["staging-deploy"]\n\n[[step]]\nid = "perf-tests"\ntitle = "Performance benchmark"\nneeds = ["staging-deploy"]\n\n[[step]]\nid = "approval-gate"\ntitle = "Final approval"\ngate = "human-approval"\nneeds = ["smoke-tests", "perf-tests"]\n\n[[step]]\nid = "tag-release"\ntitle = "Create git tag"\nneeds = ["approval-gate"]\n\n[[step]]\nid = "release-notes"\ntitle = "Publish release notes"\nneeds = ["tag-release"]\n\n[[step]]\nid = "prod-deploy"\ntitle = "Deploy to production"\nneeds = ["tag-release"]\n\n[[step]]\nid = "health-check"\ntitle = "Post-deploy health check"\nneeds = ["prod-deploy"]\n\n[[step]]\nid = "rollback-check"\ntitle = "Verify rollback plan"\nneeds = ["prod-deploy"]\n\n[[step]]\nid = "notification"\ntitle = "Notify stakeholders"\nneeds = ["health-check"]\n\n[[step]]\nid = "artifact-archive"\ntitle = "Archive build artifacts"\nneeds = ["health-check"]\n\n[[step]]\nid = "finalize"\ntitle = "Finalize release"\nneeds = ["notification", "artifact-archive", "rollback-check"]',
        stepCount: 20, estimatedDuration: '30-90 min', requiredSkills: ['developer', 'devops'],
        requiredCapabilities: ['ShellExec', 'GitPush', 'PRCreate', 'FileWrite', 'NetConnect'],
        installs: 15, rating: 4.5, ratingCount: 4, tags: ['release', 'enterprise', 'chrome'], featured: true,
      },
      {
        name: 'mol-compound-convoy', displayName: 'Compound Convoy', version: '1.0.0',
        category: 'workflow', description: 'Compound formula — chains multiple sub-formulas into a mega-workflow',
        longDescription: 'Compound Formulas combine multiple formulas into one orchestrated pipeline. Use for cross-cutting initiatives that span multiple rigs.',
        author: 'gastown', license: 'open',
        tomlTemplate: '[formula]\nname = "mol-compound-convoy"\nphase = "ice9"\ntype = "compound"\n\n[compound]\nformulas = ["mol-polecat-work", "mol-patrol-witness", "mol-beads-release"]\nstrategy = "sequential"\nsynthesis = "merge-results"',
        stepCount: 3, estimatedDuration: 'varies', requiredSkills: [],
        requiredCapabilities: [],
        installs: 8, rating: 4.2, ratingCount: 3, tags: ['compound', 'meta', 'advanced'], featured: false,
      },
    ];

    for (const b of builtins) {
      const id = `mol-${b.name}`;
      this.formulas.set(id, { ...b, id, publishedAt: new Date('2026-01-01'), updatedAt: new Date() });
    }

    log.info({ count: builtins.length }, 'Mol Mall catalog seeded');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let _mall: MolMall | null = null;

export function getMolMall(): MolMall {
  if (!_mall) _mall = new MolMall();
  return _mall;
}

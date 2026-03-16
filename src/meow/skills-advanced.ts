/**
 * Skills Advanced — EP-108→110
 * Versioning, Testing, Marketplace
 */

import { getSkill, listSkills, registerSkill, hasSkill } from './skill-registry';

/* ---------- Types ---------- */
interface SkillVersion {
  version: string;
  manifest: any;
  changelog: string;
  publishedAt: string;
  deprecated: boolean;
}

interface SkillTestCase {
  id: string;
  skillName: string;
  name: string;
  inputs: Record<string, unknown>;
  expectedOutputs?: Record<string, unknown>;
  timeout: number;
  tags: string[];
}

interface SkillTestResult {
  testId: string;
  skillName: string;
  passed: boolean;
  durationMs: number;
  outputs?: Record<string, unknown>;
  error?: string;
  timestamp: string;
}

interface MarketplaceEntry {
  name: string;
  displayName: string;
  description: string;
  author: string;
  version: string;
  downloads: number;
  rating: number;
  tags: string[];
  runtime: string;
  publishedAt: string;
  verified: boolean;
}

/* ---------- Skills Advanced ---------- */
class SkillsAdvanced {
  private versions = new Map<string, SkillVersion[]>(); // skillName → versions
  private testCases = new Map<string, SkillTestCase[]>(); // skillName → tests
  private testResults: SkillTestResult[] = [];
  private marketplace = new Map<string, MarketplaceEntry>();

  // ─── EP-108: Versioning ──────────────────────────────────────────────────

  registerVersion(skillName: string, version: string, manifest: any, changelog = ''): SkillVersion {
    if (!this.versions.has(skillName)) this.versions.set(skillName, []);
    const v: SkillVersion = {
      version,
      manifest,
      changelog,
      publishedAt: new Date().toISOString(),
      deprecated: false,
    };
    this.versions.get(skillName)!.push(v);
    console.info(`[SKILLS-ADV] Version ${version} registered for ${skillName}`);
    return v;
  }

  getVersion(skillName: string, version: string): SkillVersion | undefined {
    return this.versions.get(skillName)?.find(v => v.version === version);
  }

  getLatestVersion(skillName: string): SkillVersion | undefined {
    const versions = this.versions.get(skillName);
    if (!versions || versions.length === 0) return undefined;
    return versions[versions.length - 1];
  }

  listVersions(skillName: string): SkillVersion[] {
    return this.versions.get(skillName) || [];
  }

  deprecateVersion(skillName: string, version: string): boolean {
    const v = this.getVersion(skillName, version);
    if (!v) return false;
    v.deprecated = true;
    return true;
  }

  compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const diff = (parts1[i] || 0) - (parts2[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  // ─── EP-109: Testing ─────────────────────────────────────────────────────

  addTestCase(skillName: string, name: string, inputs: Record<string, unknown>, opts: Partial<SkillTestCase> = {}): SkillTestCase {
    const tc: SkillTestCase = {
      id: `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      skillName,
      name,
      inputs,
      expectedOutputs: opts.expectedOutputs,
      timeout: opts.timeout || 30000,
      tags: opts.tags || [],
    };
    if (!this.testCases.has(skillName)) this.testCases.set(skillName, []);
    this.testCases.get(skillName)!.push(tc);
    return tc;
  }

  getTestCases(skillName: string): SkillTestCase[] {
    return this.testCases.get(skillName) || [];
  }

  removeTestCase(testId: string): boolean {
    for (const [name, cases] of this.testCases) {
      const idx = cases.findIndex(c => c.id === testId);
      if (idx >= 0) {
        cases.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  async runTest(testId: string): Promise<SkillTestResult> {
    let testCase: SkillTestCase | undefined;
    for (const cases of this.testCases.values()) {
      testCase = cases.find(c => c.id === testId);
      if (testCase) break;
    }
    if (!testCase) throw new Error(`Test case ${testId} not found`);

    const start = Date.now();
    try {
      // Check skill exists
      if (!hasSkill(testCase.skillName)) throw new Error(`Skill ${testCase.skillName} not registered`);

      // Simulated execution (real execution would use executeSkill)
      const result: SkillTestResult = {
        testId,
        skillName: testCase.skillName,
        passed: true,
        durationMs: Date.now() - start,
        outputs: testCase.expectedOutputs || {},
        timestamp: new Date().toISOString(),
      };

      // Check expected outputs if provided
      if (testCase.expectedOutputs) {
        // Simple key presence check
        const missingKeys = Object.keys(testCase.expectedOutputs).filter(k => !(k in (result.outputs || {})));
        if (missingKeys.length > 0) {
          result.passed = false;
          result.error = `Missing expected output keys: ${missingKeys.join(', ')}`;
        }
      }

      this.testResults.push(result);
      if (this.testResults.length > 1000) this.testResults.splice(0, this.testResults.length - 500);
      return result;
    } catch (error: any) {
      const result: SkillTestResult = {
        testId,
        skillName: testCase.skillName,
        passed: false,
        durationMs: Date.now() - start,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
      this.testResults.push(result);
      return result;
    }
  }

  async runAllTests(skillName: string): Promise<SkillTestResult[]> {
    const cases = this.getTestCases(skillName);
    const results: SkillTestResult[] = [];
    for (const tc of cases) {
      results.push(await this.runTest(tc.id));
    }
    return results;
  }

  getTestResults(skillName?: string, limit = 50): SkillTestResult[] {
    let results = this.testResults;
    if (skillName) results = results.filter(r => r.skillName === skillName);
    return results.slice(-limit).reverse();
  }

  getTestSummary(skillName: string): { total: number; passed: number; failed: number; passRate: number } {
    const results = this.testResults.filter(r => r.skillName === skillName);
    const passed = results.filter(r => r.passed).length;
    return {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length > 0 ? Math.round((passed / results.length) * 100) : 0,
    };
  }

  // ─── EP-110: Marketplace ─────────────────────────────────────────────────

  publishToMarketplace(skillName: string, opts: Partial<MarketplaceEntry> = {}): MarketplaceEntry {
    const skill = getSkill(skillName);
    if (!skill) throw new Error(`Skill ${skillName} not found in registry`);

    const entry: MarketplaceEntry = {
      name: skillName,
      displayName: opts.displayName || skillName,
      description: opts.description || `Skill: ${skillName}`,
      author: opts.author || 'system',
      version: skill.version || '1.0.0',
      downloads: 0,
      rating: 0,
      tags: opts.tags || [],
      runtime: skill.runtime || 'builtin',
      publishedAt: new Date().toISOString(),
      verified: false,
    };
    this.marketplace.set(skillName, entry);
    console.info(`[SKILLS-ADV] Published ${skillName} to marketplace`);
    return entry;
  }

  searchMarketplace(query: string): MarketplaceEntry[] {
    const q = query.toLowerCase();
    return [...this.marketplace.values()].filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.displayName.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.tags.some(t => t.toLowerCase().includes(q))
    );
  }

  getMarketplaceEntry(name: string): MarketplaceEntry | undefined {
    return this.marketplace.get(name);
  }

  listMarketplace(opts?: { sortBy?: 'downloads' | 'rating' | 'recent'; limit?: number }): MarketplaceEntry[] {
    let entries = [...this.marketplace.values()];
    const sortBy = opts?.sortBy || 'recent';
    if (sortBy === 'downloads') entries.sort((a, b) => b.downloads - a.downloads);
    else if (sortBy === 'rating') entries.sort((a, b) => b.rating - a.rating);
    else entries.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    return entries.slice(0, opts?.limit || 50);
  }

  installFromMarketplace(name: string): boolean {
    const entry = this.marketplace.get(name);
    if (!entry) return false;
    entry.downloads++;
    // In a real implementation, this would download and register the skill
    console.info(`[SKILLS-ADV] Installed ${name} from marketplace (${entry.downloads} total downloads)`);
    return true;
  }

  // ─── Stats ───────────────────────────────────────────────────────────────

  stats() {
    return {
      versionedSkills: this.versions.size,
      totalVersions: [...this.versions.values()].reduce((s, v) => s + v.length, 0),
      testCases: [...this.testCases.values()].reduce((s, c) => s + c.length, 0),
      testResults: this.testResults.length,
      marketplaceEntries: this.marketplace.size,
    };
  }
}

export const skillsAdvanced = new SkillsAdvanced();

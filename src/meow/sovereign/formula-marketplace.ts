/**
 * FORMULA MARKETPLACE — SG-013 (Stage 06 Wave 4)
 *
 * Gas Town instances share formulas via a decentralized marketplace.
 * Any instance can publish formulas; other instances can browse, import,
 * rate, and track usage across the federation.
 *
 * Features:
 *   - Publish formula: instance publishes with metadata (name, description, version, perf stats, cost)
 *   - Browse/search marketplace: query by category, rating, cost range, keyword
 *   - Import formula: download into local instance with version tracking
 *   - Version management: semantic versioning, changelogs, backwards compatibility checks
 *   - Rating system: instances rate imported formulas based on real performance
 *   - Usage stats: how many instances use each formula, avg performance across adopters
 *   - Categories: campaign, content, fulfillment, analytics, recovery, expansion
 *   - Lifecycle: draft → published → deprecated → archived
 *   - DB table: meow_formula_marketplace
 *
 * Gas Town: "A good recipe deserves to be shared — the market makes formulas travel."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('formula-marketplace');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FormulaCategory =
  | 'campaign'
  | 'content'
  | 'fulfillment'
  | 'analytics'
  | 'recovery'
  | 'expansion';

export type MarketplaceListingStatus =
  | 'draft'
  | 'published'
  | 'deprecated'
  | 'archived';

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface VersionEntry {
  version: string;               // e.g. "1.2.3"
  changelog: string;
  publishedAt: Date;
  breakingChanges: boolean;
  compatibleWith: string[];      // versions this can replace
}

export interface PerformanceStats {
  avgSuccessRate: number;        // 0.0 - 1.0
  avgLatencyMs: number;
  avgCostUsd: number;
  avgOutputQuality: number;      // 1-10
  sampleSize: number;
}

export interface MarketplaceListing {
  id: string;
  formulaName: string;
  displayName: string;
  description: string;
  category: FormulaCategory;
  tags: string[];
  publisherInstanceId: string;
  publisherName: string;
  currentVersion: string;
  versions: VersionEntry[];
  status: MarketplaceListingStatus;
  performanceStats: PerformanceStats;
  costEstimateUsd: number;       // estimated cost per execution
  formulaToml: string;           // the actual formula TOML content
  avgRating: number;             // 1-5 stars
  ratingCount: number;
  importCount: number;           // total imports across all instances
  activeUsers: number;           // currently using it
  createdAt: Date;
  updatedAt: Date;
  deprecatedAt?: Date;
  deprecationReason?: string;
}

export interface FormulaImport {
  id: string;
  listingId: string;
  formulaName: string;
  importedVersion: string;
  importerInstanceId: string;
  localFormulaName: string;      // may be renamed on import
  status: 'active' | 'outdated' | 'removed';
  performanceLocal: PerformanceStats | null;
  importedAt: Date;
  lastUsedAt?: Date;
}

export interface FormulaRating {
  id: string;
  listingId: string;
  raterInstanceId: string;
  rating: number;                // 1-5
  comment: string;
  performanceEvidence: PerformanceStats | null;
  createdAt: Date;
}

export interface MarketplaceSearchQuery {
  keyword?: string;
  category?: FormulaCategory;
  minRating?: number;
  maxCostUsd?: number;
  status?: MarketplaceListingStatus;
  publisherInstanceId?: string;
  sortBy?: 'rating' | 'imports' | 'recent' | 'cost';
  limit?: number;
  offset?: number;
}

export interface MarketplaceStats {
  totalListings: number;
  publishedListings: number;
  totalImports: number;
  totalRatings: number;
  avgRating: number;
  byCategory: Record<string, number>;
  topFormulas: Array<{ name: string; imports: number; rating: number }>;
  activePublishers: number;
}

export interface MarketplaceConfig {
  maxListingsPerInstance: number;
  maxVersionsPerFormula: number;
  minRatingForHighlight: number;
  deprecationGracePeriodDays: number;
  autoArchiveAfterDays: number;
  maxInMemory: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: MarketplaceConfig = {
  maxListingsPerInstance: 100,
  maxVersionsPerFormula: 50,
  minRatingForHighlight: 4.0,
  deprecationGracePeriodDays: 30,
  autoArchiveAfterDays: 90,
  maxInMemory: 2_000,
};

const VALID_CATEGORIES: FormulaCategory[] = [
  'campaign', 'content', 'fulfillment', 'analytics', 'recovery', 'expansion',
];

const STATUS_TRANSITIONS: Record<MarketplaceListingStatus, MarketplaceListingStatus[]> = {
  draft: ['published'],
  published: ['deprecated'],
  deprecated: ['published', 'archived'],
  archived: [],
};

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGemini(prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          messages: [
            {
              role: 'system',
              content:
                'You are a formula marketplace analyst for the Gas Town MEOW system. '
                + 'You evaluate formulas for quality, compatibility, and performance potential. '
                + 'Respond ONLY with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1024,
          temperature: 0.2,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in formula-marketplace');
    return null;
  }
}

// ---------------------------------------------------------------------------
// FormulaMarketplace
// ---------------------------------------------------------------------------

export class FormulaMarketplace {
  private config: MarketplaceConfig;
  private listings = new Map<string, MarketplaceListing>();
  private imports: FormulaImport[] = [];
  private ratings: FormulaRating[] = [];

  constructor(config?: Partial<MarketplaceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info({ config: this.config }, 'FormulaMarketplace created');
  }

  // --- Publish ---------------------------------------------------------------

  async publishFormula(params: {
    formulaName: string;
    displayName: string;
    description: string;
    category: FormulaCategory;
    tags: string[];
    publisherInstanceId: string;
    publisherName: string;
    version: string;
    changelog: string;
    formulaToml: string;
    costEstimateUsd: number;
    performanceStats?: Partial<PerformanceStats>;
  }): Promise<MarketplaceListing> {
    log.info({ formulaName: params.formulaName, publisher: params.publisherInstanceId }, 'Publishing formula');

    // Validate category
    if (!VALID_CATEGORIES.includes(params.category)) {
      throw new Error(`Invalid category: ${params.category}`);
    }

    // Check publisher limit
    const existingCount = Array.from(this.listings.values())
      .filter(l => l.publisherInstanceId === params.publisherInstanceId && l.status !== 'archived')
      .length;
    if (existingCount >= this.config.maxListingsPerInstance) {
      throw new Error(`Publisher ${params.publisherInstanceId} reached max listings (${this.config.maxListingsPerInstance})`);
    }

    // Check for duplicate name from same publisher
    const duplicate = Array.from(this.listings.values()).find(
      l => l.formulaName === params.formulaName
        && l.publisherInstanceId === params.publisherInstanceId
        && l.status !== 'archived',
    );
    if (duplicate) {
      throw new Error(`Formula "${params.formulaName}" already published by this instance. Use addVersion() instead.`);
    }

    const now = new Date();
    const perfStats: PerformanceStats = {
      avgSuccessRate: params.performanceStats?.avgSuccessRate ?? 0,
      avgLatencyMs: params.performanceStats?.avgLatencyMs ?? 0,
      avgCostUsd: params.performanceStats?.avgCostUsd ?? params.costEstimateUsd,
      avgOutputQuality: params.performanceStats?.avgOutputQuality ?? 0,
      sampleSize: params.performanceStats?.sampleSize ?? 0,
    };

    const listing: MarketplaceListing = {
      id: uuidv4(),
      formulaName: params.formulaName,
      displayName: params.displayName,
      description: params.description,
      category: params.category,
      tags: params.tags,
      publisherInstanceId: params.publisherInstanceId,
      publisherName: params.publisherName,
      currentVersion: params.version,
      versions: [{
        version: params.version,
        changelog: params.changelog,
        publishedAt: now,
        breakingChanges: false,
        compatibleWith: [],
      }],
      status: 'draft',
      performanceStats: perfStats,
      costEstimateUsd: params.costEstimateUsd,
      formulaToml: params.formulaToml,
      avgRating: 0,
      ratingCount: 0,
      importCount: 0,
      activeUsers: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.listings.set(listing.id, listing);
    this.trimMemory();
    await this.persistListing(listing);

    broadcast('meow:sovereign', {
      type: 'marketplace_formula_published',
      listingId: listing.id,
      formulaName: listing.formulaName,
      publisher: listing.publisherName,
      category: listing.category,
      version: listing.currentVersion,
    });

    log.info({ listingId: listing.id, formulaName: listing.formulaName }, 'Formula published to marketplace');
    return listing;
  }

  // --- Transition status -----------------------------------------------------

  async transitionStatus(
    listingId: string,
    newStatus: MarketplaceListingStatus,
    reason?: string,
  ): Promise<MarketplaceListing> {
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error(`Listing ${listingId} not found`);

    const allowed = STATUS_TRANSITIONS[listing.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(`Cannot transition from ${listing.status} to ${newStatus}`);
    }

    listing.status = newStatus;
    listing.updatedAt = new Date();

    if (newStatus === 'deprecated') {
      listing.deprecatedAt = new Date();
      listing.deprecationReason = reason ?? 'No reason provided';
    }

    await this.persistListing(listing);

    broadcast('meow:sovereign', {
      type: 'marketplace_status_changed',
      listingId,
      formulaName: listing.formulaName,
      newStatus,
      reason,
    });

    log.info({ listingId, newStatus }, 'Listing status transitioned');
    return listing;
  }

  // --- Add version -----------------------------------------------------------

  async addVersion(
    listingId: string,
    version: string,
    changelog: string,
    formulaToml: string,
    breakingChanges: boolean,
    compatibleWith: string[],
  ): Promise<MarketplaceListing> {
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error(`Listing ${listingId} not found`);

    if (listing.versions.length >= this.config.maxVersionsPerFormula) {
      throw new Error(`Max versions reached (${this.config.maxVersionsPerFormula})`);
    }

    // Validate semantic version is higher
    const current = this.parseVersion(listing.currentVersion);
    const incoming = this.parseVersion(version);
    if (!this.isVersionHigher(incoming, current)) {
      throw new Error(`Version ${version} is not higher than current ${listing.currentVersion}`);
    }

    const entry: VersionEntry = {
      version,
      changelog,
      publishedAt: new Date(),
      breakingChanges,
      compatibleWith,
    };

    listing.versions.push(entry);
    listing.currentVersion = version;
    listing.formulaToml = formulaToml;
    listing.updatedAt = new Date();

    await this.persistListing(listing);

    // Flag outdated imports
    for (const imp of this.imports) {
      if (imp.listingId === listingId && imp.importedVersion !== version) {
        imp.status = 'outdated';
      }
    }

    broadcast('meow:sovereign', {
      type: 'marketplace_version_added',
      listingId,
      formulaName: listing.formulaName,
      version,
      breakingChanges,
    });

    log.info({ listingId, version, breakingChanges }, 'New version added');
    return listing;
  }

  // --- Search ----------------------------------------------------------------

  async search(query: MarketplaceSearchQuery): Promise<MarketplaceListing[]> {
    let results = Array.from(this.listings.values());

    // Filter by status (default: published)
    const targetStatus = query.status ?? 'published';
    results = results.filter(l => l.status === targetStatus);

    // Filter by category
    if (query.category) {
      results = results.filter(l => l.category === query.category);
    }

    // Filter by keyword
    if (query.keyword) {
      const kw = query.keyword.toLowerCase();
      results = results.filter(l =>
        l.formulaName.toLowerCase().includes(kw)
        || l.displayName.toLowerCase().includes(kw)
        || l.description.toLowerCase().includes(kw)
        || l.tags.some(t => t.toLowerCase().includes(kw)),
      );
    }

    // Filter by min rating
    if (query.minRating != null) {
      results = results.filter(l => l.avgRating >= query.minRating!);
    }

    // Filter by max cost
    if (query.maxCostUsd != null) {
      results = results.filter(l => l.costEstimateUsd <= query.maxCostUsd!);
    }

    // Filter by publisher
    if (query.publisherInstanceId) {
      results = results.filter(l => l.publisherInstanceId === query.publisherInstanceId);
    }

    // Sort
    switch (query.sortBy ?? 'rating') {
      case 'rating':
        results.sort((a, b) => b.avgRating - a.avgRating);
        break;
      case 'imports':
        results.sort((a, b) => b.importCount - a.importCount);
        break;
      case 'recent':
        results.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        break;
      case 'cost':
        results.sort((a, b) => a.costEstimateUsd - b.costEstimateUsd);
        break;
    }

    // Pagination
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return results.slice(offset, offset + limit);
  }

  // --- Import ----------------------------------------------------------------

  async importFormula(
    listingId: string,
    importerInstanceId: string,
    localFormulaName?: string,
  ): Promise<FormulaImport> {
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error(`Listing ${listingId} not found`);

    if (listing.status !== 'published') {
      throw new Error(`Cannot import formula in status "${listing.status}". Must be published.`);
    }

    // Check if already imported
    const existing = this.imports.find(
      i => i.listingId === listingId && i.importerInstanceId === importerInstanceId && i.status === 'active',
    );
    if (existing) {
      throw new Error(`Formula already imported by instance ${importerInstanceId}`);
    }

    const imp: FormulaImport = {
      id: uuidv4(),
      listingId,
      formulaName: listing.formulaName,
      importedVersion: listing.currentVersion,
      importerInstanceId,
      localFormulaName: localFormulaName ?? listing.formulaName,
      status: 'active',
      performanceLocal: null,
      importedAt: new Date(),
    };

    this.imports.push(imp);
    listing.importCount += 1;
    listing.activeUsers += 1;
    listing.updatedAt = new Date();

    await this.persistImport(imp);
    await this.persistListing(listing);

    broadcast('meow:sovereign', {
      type: 'marketplace_formula_imported',
      importId: imp.id,
      listingId,
      formulaName: listing.formulaName,
      version: listing.currentVersion,
      importerInstanceId,
    });

    log.info({ importId: imp.id, listingId, importerInstanceId }, 'Formula imported');
    return imp;
  }

  // --- Rate ------------------------------------------------------------------

  async rateFormula(
    listingId: string,
    raterInstanceId: string,
    rating: number,
    comment: string,
    performanceEvidence?: PerformanceStats,
  ): Promise<FormulaRating> {
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error(`Listing ${listingId} not found`);

    if (rating < 1 || rating > 5) throw new Error('Rating must be between 1 and 5');

    // Check rater has imported
    const hasImported = this.imports.some(
      i => i.listingId === listingId && i.importerInstanceId === raterInstanceId,
    );
    if (!hasImported) {
      throw new Error('Must import formula before rating');
    }

    const r: FormulaRating = {
      id: uuidv4(),
      listingId,
      raterInstanceId,
      rating,
      comment,
      performanceEvidence: performanceEvidence ?? null,
      createdAt: new Date(),
    };

    this.ratings.push(r);

    // Recalculate average rating
    const listingRatings = this.ratings.filter(rt => rt.listingId === listingId);
    listing.avgRating = Math.round(
      (listingRatings.reduce((sum, rt) => sum + rt.rating, 0) / listingRatings.length) * 100,
    ) / 100;
    listing.ratingCount = listingRatings.length;
    listing.updatedAt = new Date();

    await this.persistRating(r);
    await this.persistListing(listing);

    broadcast('meow:sovereign', {
      type: 'marketplace_formula_rated',
      listingId,
      formulaName: listing.formulaName,
      rating,
      newAvgRating: listing.avgRating,
      ratingCount: listing.ratingCount,
    });

    log.info({ listingId, rating, newAvg: listing.avgRating }, 'Formula rated');
    return r;
  }

  // --- AI evaluation ---------------------------------------------------------

  async evaluateFormula(listingId: string): Promise<{
    qualityScore: number;
    suggestions: string[];
    riskLevel: string;
  }> {
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error(`Listing ${listingId} not found`);

    const prompt = `Evaluate this formula for marketplace quality:
Name: ${listing.formulaName}
Description: ${listing.description}
Category: ${listing.category}
TOML (first 2000 chars):
${listing.formulaToml.slice(0, 2000)}

Performance: success_rate=${listing.performanceStats.avgSuccessRate}, avg_latency=${listing.performanceStats.avgLatencyMs}ms, cost=$${listing.performanceStats.avgCostUsd}

Return JSON: {"qualityScore": 0-100, "suggestions": ["..."], "riskLevel": "low"|"medium"|"high"}`;

    const raw = await callGemini(prompt);
    if (raw) {
      try {
        const cleaned = raw.replace(/```json\s*/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned) as { qualityScore: number; suggestions: string[]; riskLevel: string };
        return {
          qualityScore: Math.min(100, Math.max(0, parsed.qualityScore ?? 50)),
          suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 10) : [],
          riskLevel: ['low', 'medium', 'high'].includes(parsed.riskLevel) ? parsed.riskLevel : 'medium',
        };
      } catch {
        log.warn('Failed to parse Gemini evaluation response');
      }
    }

    // Heuristic fallback
    const quality = Math.min(100, Math.round(
      (listing.performanceStats.avgSuccessRate * 40)
      + (listing.avgRating / 5 * 30)
      + (listing.ratingCount > 0 ? 10 : 0)
      + (listing.description.length > 50 ? 10 : 0)
      + (listing.tags.length >= 3 ? 10 : 0),
    ));

    return {
      qualityScore: quality,
      suggestions: ['Add more tags for discoverability', 'Include usage examples in description'],
      riskLevel: listing.performanceStats.avgSuccessRate > 0.8 ? 'low' : 'medium',
    };
  }

  // --- Usage stats -----------------------------------------------------------

  getUsageStats(listingId: string): {
    totalImports: number;
    activeInstances: number;
    outdatedInstances: number;
    avgLocalPerformance: PerformanceStats | null;
  } {
    const listingImports = this.imports.filter(i => i.listingId === listingId);
    const active = listingImports.filter(i => i.status === 'active');
    const outdated = listingImports.filter(i => i.status === 'outdated');

    // Aggregate local performance
    const withPerf = active.filter(i => i.performanceLocal != null);
    let avgPerf: PerformanceStats | null = null;
    if (withPerf.length > 0) {
      avgPerf = {
        avgSuccessRate: withPerf.reduce((s, i) => s + i.performanceLocal!.avgSuccessRate, 0) / withPerf.length,
        avgLatencyMs: withPerf.reduce((s, i) => s + i.performanceLocal!.avgLatencyMs, 0) / withPerf.length,
        avgCostUsd: withPerf.reduce((s, i) => s + i.performanceLocal!.avgCostUsd, 0) / withPerf.length,
        avgOutputQuality: withPerf.reduce((s, i) => s + i.performanceLocal!.avgOutputQuality, 0) / withPerf.length,
        sampleSize: withPerf.reduce((s, i) => s + i.performanceLocal!.sampleSize, 0),
      };
    }

    return {
      totalImports: listingImports.length,
      activeInstances: active.length,
      outdatedInstances: outdated.length,
      avgLocalPerformance: avgPerf,
    };
  }

  // --- Deprecation management ------------------------------------------------

  async autoDeprecateStale(): Promise<string[]> {
    const now = Date.now();
    const gracePeriodMs = this.config.autoArchiveAfterDays * 24 * 60 * 60 * 1000;
    const deprecated: string[] = [];

    for (const listing of this.listings.values()) {
      if (listing.status === 'deprecated' && listing.deprecatedAt) {
        const elapsed = now - listing.deprecatedAt.getTime();
        if (elapsed > gracePeriodMs) {
          listing.status = 'archived';
          listing.updatedAt = new Date();
          await this.persistListing(listing);
          deprecated.push(listing.id);
          log.info({ listingId: listing.id, formulaName: listing.formulaName }, 'Auto-archived deprecated formula');
        }
      }
    }

    if (deprecated.length > 0) {
      broadcast('meow:sovereign', {
        type: 'marketplace_auto_archived',
        count: deprecated.length,
        listingIds: deprecated,
      });
    }

    return deprecated;
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): MarketplaceStats {
    const all = Array.from(this.listings.values());
    const published = all.filter(l => l.status === 'published');
    const byCategory: Record<string, number> = {};
    for (const cat of VALID_CATEGORIES) {
      byCategory[cat] = published.filter(l => l.category === cat).length;
    }

    const topFormulas = published
      .sort((a, b) => b.importCount - a.importCount)
      .slice(0, 10)
      .map(l => ({ name: l.formulaName, imports: l.importCount, rating: l.avgRating }));

    const publisherSet = new Set(published.map(l => l.publisherInstanceId));

    return {
      totalListings: all.length,
      publishedListings: published.length,
      totalImports: this.imports.length,
      totalRatings: this.ratings.length,
      avgRating: published.length > 0
        ? Math.round(published.reduce((s, l) => s + l.avgRating, 0) / published.length * 100) / 100
        : 0,
      byCategory,
      topFormulas,
      activePublishers: publisherSet.size,
    };
  }

  // --- Getters ---------------------------------------------------------------

  getListing(id: string): MarketplaceListing | undefined {
    return this.listings.get(id);
  }

  getImportsForInstance(instanceId: string): FormulaImport[] {
    return this.imports.filter(i => i.importerInstanceId === instanceId);
  }

  getRatings(listingId: string): FormulaRating[] {
    return this.ratings.filter(r => r.listingId === listingId);
  }

  // --- Version helpers -------------------------------------------------------

  private parseVersion(v: string): SemanticVersion {
    const parts = v.replace(/^v/, '').split('.').map(Number);
    return {
      major: parts[0] ?? 0,
      minor: parts[1] ?? 0,
      patch: parts[2] ?? 0,
    };
  }

  private isVersionHigher(a: SemanticVersion, b: SemanticVersion): boolean {
    if (a.major !== b.major) return a.major > b.major;
    if (a.minor !== b.minor) return a.minor > b.minor;
    return a.patch > b.patch;
  }

  // --- Memory management -----------------------------------------------------

  private trimMemory(): void {
    if (this.listings.size > this.config.maxInMemory) {
      const sorted = Array.from(this.listings.entries())
        .sort((a, b) => a[1].updatedAt.getTime() - b[1].updatedAt.getTime());
      const toRemove = sorted.slice(0, sorted.length - this.config.maxInMemory);
      for (const [key] of toRemove) {
        this.listings.delete(key);
      }
    }
    if (this.imports.length > this.config.maxInMemory * 2) {
      this.imports = this.imports.slice(-this.config.maxInMemory * 2);
    }
    if (this.ratings.length > this.config.maxInMemory * 2) {
      this.ratings = this.ratings.slice(-this.config.maxInMemory * 2);
    }
  }

  // --- DB persistence --------------------------------------------------------

  private async persistListing(listing: MarketplaceListing): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_formula_marketplace
          (id, formula_name, display_name, description, category, tags, publisher_instance_id,
           publisher_name, current_version, versions, status, performance_stats, cost_estimate_usd,
           formula_toml, avg_rating, rating_count, import_count, active_users,
           created_at, updated_at, deprecated_at, deprecation_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           current_version = EXCLUDED.current_version,
           versions = EXCLUDED.versions,
           status = EXCLUDED.status,
           performance_stats = EXCLUDED.performance_stats,
           cost_estimate_usd = EXCLUDED.cost_estimate_usd,
           formula_toml = EXCLUDED.formula_toml,
           avg_rating = EXCLUDED.avg_rating,
           rating_count = EXCLUDED.rating_count,
           import_count = EXCLUDED.import_count,
           active_users = EXCLUDED.active_users,
           updated_at = EXCLUDED.updated_at,
           deprecated_at = EXCLUDED.deprecated_at,
           deprecation_reason = EXCLUDED.deprecation_reason`,
        [
          listing.id,
          listing.formulaName,
          listing.displayName,
          listing.description,
          listing.category,
          JSON.stringify(listing.tags),
          listing.publisherInstanceId,
          listing.publisherName,
          listing.currentVersion,
          JSON.stringify(listing.versions),
          listing.status,
          JSON.stringify(listing.performanceStats),
          listing.costEstimateUsd,
          listing.formulaToml,
          listing.avgRating,
          listing.ratingCount,
          listing.importCount,
          listing.activeUsers,
          listing.createdAt.toISOString(),
          listing.updatedAt.toISOString(),
          listing.deprecatedAt?.toISOString() ?? null,
          listing.deprecationReason ?? null,
        ],
      );
    } catch (err) {
      log.error({ err, listingId: listing.id }, 'Failed to persist marketplace listing');
    }
  }

  private async persistImport(imp: FormulaImport): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_formula_marketplace_imports
          (id, listing_id, formula_name, imported_version, importer_instance_id,
           local_formula_name, status, performance_local, imported_at, last_used_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           performance_local = EXCLUDED.performance_local,
           last_used_at = EXCLUDED.last_used_at`,
        [
          imp.id,
          imp.listingId,
          imp.formulaName,
          imp.importedVersion,
          imp.importerInstanceId,
          imp.localFormulaName,
          imp.status,
          imp.performanceLocal ? JSON.stringify(imp.performanceLocal) : null,
          imp.importedAt.toISOString(),
          imp.lastUsedAt?.toISOString() ?? null,
        ],
      );
    } catch (err) {
      log.error({ err, importId: imp.id }, 'Failed to persist formula import');
    }
  }

  private async persistRating(r: FormulaRating): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_formula_marketplace_ratings
          (id, listing_id, rater_instance_id, rating, comment, performance_evidence, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          r.id,
          r.listingId,
          r.raterInstanceId,
          r.rating,
          r.comment,
          r.performanceEvidence ? JSON.stringify(r.performanceEvidence) : null,
          r.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, ratingId: r.id }, 'Failed to persist formula rating');
    }
  }

  // --- Load from DB ----------------------------------------------------------

  async loadFromDb(): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      const { rows } = await pool.query(
        `SELECT * FROM meow_formula_marketplace ORDER BY updated_at DESC LIMIT $1`,
        [this.config.maxInMemory],
      );

      for (const row of rows) {
        const listing: MarketplaceListing = {
          id: row.id,
          formulaName: row.formula_name,
          displayName: row.display_name,
          description: row.description ?? '',
          category: row.category,
          tags: this.parseJsonSafe(row.tags, []),
          publisherInstanceId: row.publisher_instance_id,
          publisherName: row.publisher_name ?? '',
          currentVersion: row.current_version ?? '1.0.0',
          versions: this.parseJsonSafe(row.versions, []),
          status: row.status ?? 'draft',
          performanceStats: this.parseJsonSafe(row.performance_stats, {
            avgSuccessRate: 0, avgLatencyMs: 0, avgCostUsd: 0, avgOutputQuality: 0, sampleSize: 0,
          }),
          costEstimateUsd: parseFloat(row.cost_estimate_usd ?? '0'),
          formulaToml: row.formula_toml ?? '',
          avgRating: parseFloat(row.avg_rating ?? '0'),
          ratingCount: parseInt(row.rating_count ?? '0', 10),
          importCount: parseInt(row.import_count ?? '0', 10),
          activeUsers: parseInt(row.active_users ?? '0', 10),
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
          deprecatedAt: row.deprecated_at ? new Date(row.deprecated_at) : undefined,
          deprecationReason: row.deprecation_reason ?? undefined,
        };
        this.listings.set(listing.id, listing);
      }

      log.info({ loaded: rows.length }, 'Loaded marketplace listings from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load marketplace from DB');
    }
  }

  private parseJsonSafe<T>(raw: unknown, fallback: T): T {
    if (raw == null) return fallback;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as T; } catch { return fallback; }
    }
    if (typeof raw === 'object') return raw as T;
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: FormulaMarketplace | null = null;

export function getFormulaMarketplace(
  config?: Partial<MarketplaceConfig>,
): FormulaMarketplace {
  if (!instance) {
    instance = new FormulaMarketplace(config);
    log.info('FormulaMarketplace singleton created');
  }
  return instance;
}

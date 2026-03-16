/**
 * ATLAS WORLD ADVISOR -- SG-002 (Stage 06 Wave 1)
 *
 * ATLAS country intelligence feeds Gas Town operations with real-time
 * geopolitical awareness for 7+1 markets:
 *   AR (Argentina), BR (Brazil), MX (Mexico), CO (Colombia),
 *   CL (Chile), PE (Peru), EC (Ecuador), EU (Spain/Portugal)
 *
 * This is the higher-level strategic layer above atlas-country-injection.ts
 * (Stage 05 CG-023). While CG-023 injects raw country data into formulas,
 * this module:
 *   - Detects market condition changes proactively
 *   - Publishes structured advisories with recommended actions
 *   - Auto-injects country context into formula variables before execution
 *   - Feeds intelligence to MOROS for strategic directive generation
 *
 * Advisory types:
 *   - market_opportunity:   Favorable conditions detected (currency dip, holiday)
 *   - regulatory_alert:     Regulation change or compliance risk
 *   - competitive_threat:   Competitor action detected
 *   - seasonal_prep:        Upcoming seasonal event requiring preparation
 *
 * Advisory lifecycle:
 *   detected -> assessed -> published -> acted_on -> archived
 *
 * Configurable scan interval (default: every 4 hours).
 * Full audit trail in meow_world_advisories DB table.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('atlas-world-advisor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MarketCode = 'AR' | 'BR' | 'MX' | 'CO' | 'CL' | 'PE' | 'EC' | 'EU';

export type AdvisoryType =
  | 'market_opportunity'
  | 'regulatory_alert'
  | 'competitive_threat'
  | 'seasonal_prep';

export type AdvisoryStatus =
  | 'detected'
  | 'assessed'
  | 'published'
  | 'acted_on'
  | 'archived';

export type AdvisorySeverity = 'info' | 'warning' | 'critical';

export interface WorldAdvisory {
  id: string;
  type: AdvisoryType;
  status: AdvisoryStatus;
  severity: AdvisorySeverity;
  title: string;
  description: string;
  countryCodes: MarketCode[];
  signals: MarketSignal[];
  recommendedActions: string[];
  formulaVariableOverrides: Record<string, unknown>;
  confidenceScore: number;            // 0.0 - 1.0
  expiresAt: Date | null;
  createdAt: Date;
  assessedAt: Date | null;
  publishedAt: Date | null;
  actedOnAt: Date | null;
  archivedAt: Date | null;
  metadata?: Record<string, unknown>;
}

export interface MarketSignal {
  source: string;                     // where the signal came from
  signalType: string;                 // e.g. 'currency_shift', 'regulation_update'
  value: string | number;
  previousValue?: string | number;
  detectedAt: Date;
  reliability: number;                // 0.0 - 1.0
}

export interface MarketConditionSnapshot {
  countryCode: MarketCode;
  currencyTrend: 'strengthening' | 'stable' | 'weakening';
  regulatoryRisk: 'low' | 'medium' | 'high';
  competitiveIntensity: 'low' | 'medium' | 'high';
  seasonalRelevance: number;          // 0.0 - 1.0
  overallSentiment: 'bullish' | 'neutral' | 'bearish';
  activeAdvisoryCount: number;
  lastScanAt: Date;
}

export interface FormulaContextInjection {
  formulaId: string;
  countryCodes: MarketCode[];
  variables: Record<string, unknown>;
  advisoryIds: string[];
  injectedAt: Date;
}

export interface AtlasWorldConfig {
  scanIntervalMs: number;             // default 4h
  maxActiveAdvisories: number;
  autoPublishLowSeverity: boolean;
  advisoryTtlDays: number;            // auto-archive after N days
  enableFormulaInjection: boolean;
}

export interface AtlasWorldStats {
  totalAdvisories: number;
  activeAdvisories: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  byCountry: Record<string, number>;
  avgConfidence: number;
  lastScanAt: Date | null;
  nextScanAt: Date | null;
  formulaInjectionsTotal: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_MARKETS: MarketCode[] = ['AR', 'BR', 'MX', 'CO', 'CL', 'PE', 'EC', 'EU'];

const MARKET_NAMES: Record<MarketCode, string> = {
  AR: 'Argentina',
  BR: 'Brazil',
  MX: 'Mexico',
  CO: 'Colombia',
  CL: 'Chile',
  PE: 'Peru',
  EC: 'Ecuador',
  EU: 'Europe (ES/PT)',
};

/** Upcoming seasonal events by country — static calendar */
const SEASONAL_CALENDAR: Array<{ countries: MarketCode[]; event: string; month: number; day: number }> = [
  { countries: ['MX'], event: 'Buen Fin', month: 11, day: 15 },
  { countries: ['AR', 'BR', 'MX', 'CO', 'CL', 'PE', 'EC', 'EU'], event: 'Black Friday', month: 11, day: 25 },
  { countries: ['AR', 'BR', 'MX', 'CO', 'CL', 'PE', 'EC', 'EU'], event: 'Christmas', month: 12, day: 25 },
  { countries: ['CL'], event: 'CyberMonday CL', month: 11, day: 1 },
  { countries: ['BR'], event: 'Dia dos Namorados', month: 6, day: 12 },
  { countries: ['AR', 'MX', 'CO', 'CL', 'PE', 'EC'], event: 'Dia de la Madre', month: 5, day: 10 },
  { countries: ['PE'], event: 'Fiestas Patrias', month: 7, day: 28 },
  { countries: ['EU'], event: 'Rebajas/Saldos', month: 1, day: 7 },
  { countries: ['MX'], event: 'Dia de Muertos', month: 11, day: 2 },
  { countries: ['CO'], event: 'Amor y Amistad', month: 9, day: 20 },
  { countries: ['AR'], event: 'Hot Sale', month: 5, day: 15 },
];

const DEFAULT_CONFIG: AtlasWorldConfig = {
  scanIntervalMs: 4 * 60 * 60 * 1000, // 4 hours
  maxActiveAdvisories: 50,
  autoPublishLowSeverity: true,
  advisoryTtlDays: 14,
  enableFormulaInjection: true,
};

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGemini(systemPrompt: string, userPrompt: string): Promise<string | null> {
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
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 2048,
          temperature: 0.2,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in atlas-world-advisor');
    return null;
  }
}

// ---------------------------------------------------------------------------
// AtlasWorldAdvisor
// ---------------------------------------------------------------------------

export class AtlasWorldAdvisor {
  private advisories: WorldAdvisory[] = [];
  private conditionSnapshots = new Map<MarketCode, MarketConditionSnapshot>();
  private formulaInjections: FormulaContextInjection[] = [];
  private config: AtlasWorldConfig;
  private maxInMemory = 5_000;
  private scanTimer: NodeJS.Timeout | null = null;
  private lastScanAt: Date | null = null;

  constructor(config?: Partial<AtlasWorldConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --- Start periodic market scan --------------------------------------------

  startPeriodicScan(): void {
    if (this.scanTimer) return;

    this.scanTimer = setInterval(async () => {
      try {
        await this.conductMarketScan();
      } catch (err) {
        log.error({ err }, 'Periodic market scan failed');
      }
    }, this.config.scanIntervalMs);

    log.info(
      { intervalMs: this.config.scanIntervalMs },
      'ATLAS periodic market scan started',
    );
  }

  stopPeriodicScan(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
      log.info('ATLAS periodic market scan stopped');
    }
  }

  // --- Conduct full market scan ----------------------------------------------

  async conductMarketScan(): Promise<WorldAdvisory[]> {
    log.info('ATLAS conducting market scan across all markets...');
    const startMs = Date.now();
    const newAdvisories: WorldAdvisory[] = [];

    // 1. Scan each market for condition changes
    for (const market of ALL_MARKETS) {
      const snapshot = await this.scanMarket(market);
      this.conditionSnapshots.set(market, snapshot);
    }

    // 2. Detect seasonal events approaching
    const seasonalAdvisories = this.detectSeasonalEvents();
    newAdvisories.push(...seasonalAdvisories);

    // 3. AI-powered assessment of current conditions
    const aiAdvisories = await this.generateAiAdvisories();
    newAdvisories.push(...aiAdvisories);

    // 4. Check for currency fluctuations
    const currencyAdvisories = await this.detectCurrencyFluctuations();
    newAdvisories.push(...currencyAdvisories);

    // 5. Deduplicate
    const novel = this.filterNovelAdvisories(newAdvisories);

    // 6. Store and publish
    for (const advisory of novel) {
      if (this.config.autoPublishLowSeverity && advisory.severity === 'info') {
        advisory.status = 'published';
        advisory.publishedAt = new Date();
      }
      this.advisories.push(advisory);
      await this.persistAdvisory(advisory);
    }

    // 7. Auto-archive expired
    await this.archiveExpired();

    // Evict old in-memory
    if (this.advisories.length > this.maxInMemory) {
      this.advisories = this.advisories.slice(-this.maxInMemory);
    }

    this.lastScanAt = new Date();
    const elapsedMs = Date.now() - startMs;

    broadcast('meow:sovereign', {
      type: 'atlas_market_scan_complete',
      newAdvisories: novel.length,
      totalActive: this.getActiveAdvisories().length,
      marketsScanned: ALL_MARKETS.length,
      elapsedMs,
    });

    log.info({ newAdvisories: novel.length, elapsedMs }, 'ATLAS market scan complete');
    return novel;
  }

  // --- Create manual advisory ------------------------------------------------

  async createAdvisory(
    type: AdvisoryType,
    title: string,
    description: string,
    countryCodes: MarketCode[],
    severity: AdvisorySeverity,
  ): Promise<WorldAdvisory> {
    const advisory: WorldAdvisory = {
      id: uuidv4(),
      type,
      status: 'detected',
      severity,
      title,
      description,
      countryCodes,
      signals: [],
      recommendedActions: [],
      formulaVariableOverrides: {},
      confidenceScore: 0.7,
      expiresAt: new Date(Date.now() + this.config.advisoryTtlDays * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      assessedAt: null,
      publishedAt: null,
      actedOnAt: null,
      archivedAt: null,
    };

    // AI-enhanced assessment
    const assessed = await this.assessAdvisory(advisory);
    if (assessed) {
      advisory.recommendedActions = assessed.recommendedActions;
      advisory.formulaVariableOverrides = assessed.formulaVariableOverrides;
      advisory.confidenceScore = assessed.confidenceScore;
      advisory.status = 'assessed';
      advisory.assessedAt = new Date();
    }

    this.advisories.push(advisory);
    await this.persistAdvisory(advisory);

    broadcast('meow:sovereign', {
      type: 'atlas_advisory_created',
      advisoryId: advisory.id,
      advisoryType: advisory.type,
      severity: advisory.severity,
      countries: advisory.countryCodes,
      title: advisory.title,
    });

    log.info({ id: advisory.id, type, severity, countries: countryCodes }, 'Advisory created');
    return advisory;
  }

  // --- Publish advisory ------------------------------------------------------

  async publishAdvisory(advisoryId: string): Promise<boolean> {
    const advisory = this.advisories.find(a => a.id === advisoryId);
    if (!advisory) return false;
    if (advisory.status === 'published' || advisory.status === 'archived') return false;

    advisory.status = 'published';
    advisory.publishedAt = new Date();
    if (!advisory.assessedAt) advisory.assessedAt = new Date();

    await this.updateAdvisoryStatus(advisory);

    broadcast('meow:sovereign', {
      type: 'atlas_advisory_published',
      advisoryId: advisory.id,
      title: advisory.title,
      countries: advisory.countryCodes,
      severity: advisory.severity,
    });

    log.info({ advisoryId, title: advisory.title }, 'Advisory published');
    return true;
  }

  // --- Mark advisory as acted on ---------------------------------------------

  async markActedOn(advisoryId: string): Promise<boolean> {
    const advisory = this.advisories.find(a => a.id === advisoryId);
    if (!advisory || advisory.status !== 'published') return false;

    advisory.status = 'acted_on';
    advisory.actedOnAt = new Date();
    await this.updateAdvisoryStatus(advisory);

    log.info({ advisoryId }, 'Advisory marked as acted on');
    return true;
  }

  // --- Archive advisory ------------------------------------------------------

  async archiveAdvisory(advisoryId: string): Promise<boolean> {
    const advisory = this.advisories.find(a => a.id === advisoryId);
    if (!advisory || advisory.status === 'archived') return false;

    advisory.status = 'archived';
    advisory.archivedAt = new Date();
    await this.updateAdvisoryStatus(advisory);

    log.info({ advisoryId }, 'Advisory archived');
    return true;
  }

  // --- Inject country context into formula variables -------------------------

  getFormulaContextForCountries(
    formulaId: string,
    countryCodes: MarketCode[],
  ): FormulaContextInjection {
    const activeAdvisories = this.advisories.filter(
      a =>
        (a.status === 'published' || a.status === 'assessed') &&
        a.countryCodes.some(c => countryCodes.includes(c)) &&
        Object.keys(a.formulaVariableOverrides).length > 0,
    );

    const variables: Record<string, unknown> = {};
    const advisoryIds: string[] = [];

    for (const advisory of activeAdvisories) {
      for (const [key, value] of Object.entries(advisory.formulaVariableOverrides)) {
        variables[key] = value; // Last advisory wins for same key
      }
      advisoryIds.push(advisory.id);
    }

    // Add condition snapshots
    for (const code of countryCodes) {
      const snapshot = this.conditionSnapshots.get(code);
      if (snapshot) {
        variables[`${code.toLowerCase()}_currency_trend`] = snapshot.currencyTrend;
        variables[`${code.toLowerCase()}_regulatory_risk`] = snapshot.regulatoryRisk;
        variables[`${code.toLowerCase()}_seasonal_relevance`] = snapshot.seasonalRelevance;
        variables[`${code.toLowerCase()}_sentiment`] = snapshot.overallSentiment;
      }
    }

    const injection: FormulaContextInjection = {
      formulaId,
      countryCodes,
      variables,
      advisoryIds,
      injectedAt: new Date(),
    };

    this.formulaInjections.push(injection);
    if (this.formulaInjections.length > 10_000) {
      this.formulaInjections = this.formulaInjections.slice(-10_000);
    }

    return injection;
  }

  // --- Get market condition snapshot -----------------------------------------

  getMarketSnapshot(code: MarketCode): MarketConditionSnapshot | null {
    return this.conditionSnapshots.get(code) ?? null;
  }

  getAllMarketSnapshots(): MarketConditionSnapshot[] {
    return Array.from(this.conditionSnapshots.values());
  }

  // --- Getters ---------------------------------------------------------------

  getAdvisory(id: string): WorldAdvisory | null {
    return this.advisories.find(a => a.id === id) ?? null;
  }

  getActiveAdvisories(): WorldAdvisory[] {
    return this.advisories.filter(
      a => a.status !== 'archived' && (!a.expiresAt || a.expiresAt > new Date()),
    );
  }

  getAdvisoriesForCountry(code: MarketCode): WorldAdvisory[] {
    return this.advisories.filter(
      a => a.countryCodes.includes(code) && a.status !== 'archived',
    );
  }

  getAdvisoriesByType(type: AdvisoryType): WorldAdvisory[] {
    return this.advisories.filter(a => a.type === type && a.status !== 'archived');
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): AtlasWorldStats {
    const total = this.advisories.length;
    const active = this.getActiveAdvisories().length;

    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byCountry: Record<string, number> = {};
    let totalConfidence = 0;

    for (const a of this.advisories) {
      byType[a.type] = (byType[a.type] ?? 0) + 1;
      bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
      for (const c of a.countryCodes) {
        byCountry[c] = (byCountry[c] ?? 0) + 1;
      }
      totalConfidence += a.confidenceScore;
    }

    const nextScanAt = this.lastScanAt
      ? new Date(this.lastScanAt.getTime() + this.config.scanIntervalMs)
      : null;

    return {
      totalAdvisories: total,
      activeAdvisories: active,
      byType,
      bySeverity,
      byCountry,
      avgConfidence: total > 0 ? Math.round((totalConfidence / total) * 1000) / 1000 : 0,
      lastScanAt: this.lastScanAt,
      nextScanAt,
      formulaInjectionsTotal: this.formulaInjections.length,
    };
  }

  // --- Update config ---------------------------------------------------------

  updateConfig(updates: Partial<AtlasWorldConfig>): void {
    this.config = { ...this.config, ...updates };
    if (updates.scanIntervalMs && this.scanTimer) {
      this.stopPeriodicScan();
      this.startPeriodicScan();
    }
    log.info({ config: this.config }, 'ATLAS config updated');
  }

  // --- Load from DB ----------------------------------------------------------

  async loadFromDb(sinceDays = 30): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, advisory_type, status, severity, title, description,
                country_codes, signals, recommended_actions,
                formula_variable_overrides, confidence_score,
                expires_at, created_at, assessed_at, published_at,
                acted_on_at, archived_at, metadata
         FROM meow_world_advisories
         WHERE created_at > NOW() - INTERVAL '1 day' * $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [sinceDays, this.maxInMemory],
      );

      this.advisories = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        type: r.advisory_type as AdvisoryType,
        status: r.status as AdvisoryStatus,
        severity: (r.severity as AdvisorySeverity) ?? 'info',
        title: (r.title as string) ?? '',
        description: (r.description as string) ?? '',
        countryCodes: this.parseJsonSafe(r.country_codes, []),
        signals: this.parseJsonSafe(r.signals, []),
        recommendedActions: this.parseJsonSafe(r.recommended_actions, []),
        formulaVariableOverrides: this.parseJsonSafe(r.formula_variable_overrides, {}),
        confidenceScore: parseFloat(String(r.confidence_score ?? '0')),
        expiresAt: r.expires_at ? new Date(r.expires_at as string) : null,
        createdAt: new Date(r.created_at as string),
        assessedAt: r.assessed_at ? new Date(r.assessed_at as string) : null,
        publishedAt: r.published_at ? new Date(r.published_at as string) : null,
        actedOnAt: r.acted_on_at ? new Date(r.acted_on_at as string) : null,
        archivedAt: r.archived_at ? new Date(r.archived_at as string) : null,
        metadata: this.parseJsonSafe(r.metadata, {}),
      }));

      log.info({ count: this.advisories.length }, 'Loaded world advisories from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load world advisories from DB');
    }
  }

  // --- Destroy ---------------------------------------------------------------

  destroy(): void {
    this.stopPeriodicScan();
    log.info('AtlasWorldAdvisor destroyed');
  }

  // ---------------------------------------------------------------------------
  // Private: Market Scanning
  // ---------------------------------------------------------------------------

  private async scanMarket(code: MarketCode): Promise<MarketConditionSnapshot> {
    const pool = getPool();
    const existing = this.conditionSnapshots.get(code);

    // Default snapshot
    const snapshot: MarketConditionSnapshot = {
      countryCode: code,
      currencyTrend: 'stable',
      regulatoryRisk: 'low',
      competitiveIntensity: 'medium',
      seasonalRelevance: this.calculateSeasonalRelevance(code),
      overallSentiment: 'neutral',
      activeAdvisoryCount: this.getAdvisoriesForCountry(code).length,
      lastScanAt: new Date(),
    };

    if (!pool) return snapshot;

    // Query recent performance for this country
    try {
      const { rows } = await pool.query(
        `SELECT metric_name, metric_value
         FROM meow_performance_metrics
         WHERE country_code = $1
           AND recorded_at > NOW() - INTERVAL '48 hours'
         ORDER BY recorded_at DESC
         LIMIT 20`,
        [code],
      );

      if (rows.length > 0) {
        const metrics = rows as Array<Record<string, unknown>>;
        const roasMetric = metrics.find(m => String(m.metric_name).includes('roas'));
        const cpaMetric = metrics.find(m => String(m.metric_name).includes('cpa'));

        if (roasMetric) {
          const roas = parseFloat(String(roasMetric.metric_value ?? '0'));
          snapshot.overallSentiment = roas > 2.0 ? 'bullish' : roas > 1.0 ? 'neutral' : 'bearish';
        }

        if (cpaMetric) {
          const cpa = parseFloat(String(cpaMetric.metric_value ?? '0'));
          snapshot.competitiveIntensity = cpa > 25 ? 'high' : cpa > 15 ? 'medium' : 'low';
        }
      }
    } catch (err) {
      log.warn({ err, code }, 'Failed to query performance metrics for market scan');
    }

    // Query exchange rate trend from country intelligence
    try {
      const { rows } = await pool.query(
        `SELECT exchange_rate_to_usd, last_refreshed
         FROM meow_country_intelligence
         WHERE country_code = $1
         LIMIT 1`,
        [code],
      );

      if (rows.length > 0 && existing) {
        // Compare with previous snapshot if available
        snapshot.currencyTrend = existing.currencyTrend; // maintain last known
      }
    } catch (err) {
      log.warn({ err, code }, 'Failed to query exchange rate for market scan');
    }

    return snapshot;
  }

  private calculateSeasonalRelevance(code: MarketCode): number {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    let maxRelevance = 0;
    for (const event of SEASONAL_CALENDAR) {
      if (!event.countries.includes(code)) continue;

      const daysUntilEvent = this.daysUntil(month, day, event.month, event.day);
      if (daysUntilEvent <= 30) {
        const relevance = Math.max(0, 1 - daysUntilEvent / 30);
        maxRelevance = Math.max(maxRelevance, relevance);
      }
    }

    return Math.round(maxRelevance * 100) / 100;
  }

  private daysUntil(curMonth: number, curDay: number, targetMonth: number, targetDay: number): number {
    const now = new Date();
    const target = new Date(now.getFullYear(), targetMonth - 1, targetDay);
    if (target < now) {
      target.setFullYear(target.getFullYear() + 1);
    }
    return Math.floor((target.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  }

  // ---------------------------------------------------------------------------
  // Private: Seasonal Detection
  // ---------------------------------------------------------------------------

  private detectSeasonalEvents(): WorldAdvisory[] {
    const advisories: WorldAdvisory[] = [];
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    for (const event of SEASONAL_CALENDAR) {
      const daysUntil = this.daysUntil(month, day, event.month, event.day);

      // Trigger advisory 21 days before event
      if (daysUntil <= 21 && daysUntil > 0) {
        // Check if we already have this advisory
        const alreadyExists = this.advisories.some(
          a =>
            a.type === 'seasonal_prep' &&
            a.title.includes(event.event) &&
            a.status !== 'archived',
        );

        if (alreadyExists) continue;

        advisories.push({
          id: uuidv4(),
          type: 'seasonal_prep',
          status: 'detected',
          severity: daysUntil <= 7 ? 'warning' : 'info',
          title: `${event.event} in ${daysUntil} days`,
          description: `Seasonal event "${event.event}" is approaching in ${daysUntil} days for ${event.countries.join(', ')}. Prepare campaigns, inventory, and creative assets.`,
          countryCodes: event.countries,
          signals: [{
            source: 'seasonal_calendar',
            signalType: 'upcoming_event',
            value: event.event,
            detectedAt: new Date(),
            reliability: 1.0,
          }],
          recommendedActions: [
            `Prepare ${event.event} campaign creatives`,
            `Review inventory for ${event.countries.join('/')} markets`,
            `Schedule ad budget increase for ${event.event} period`,
            daysUntil <= 7 ? 'URGENT: Launch campaigns NOW' : `Plan launch for ${daysUntil - 7} days from now`,
          ],
          formulaVariableOverrides: {
            seasonal_event: event.event,
            seasonal_urgency: daysUntil <= 7 ? 'high' : 'medium',
            seasonal_days_remaining: daysUntil,
          },
          confidenceScore: 1.0,
          expiresAt: new Date(now.getFullYear(), event.month - 1, event.day + 2),
          createdAt: new Date(),
          assessedAt: new Date(),
          publishedAt: null,
          actedOnAt: null,
          archivedAt: null,
        });
      }
    }

    return advisories;
  }

  // ---------------------------------------------------------------------------
  // Private: AI-Powered Advisory Generation
  // ---------------------------------------------------------------------------

  private async generateAiAdvisories(): Promise<WorldAdvisory[]> {
    const snapshots = Array.from(this.conditionSnapshots.entries())
      .map(([code, snap]) =>
        `${code} (${MARKET_NAMES[code]}): sentiment=${snap.overallSentiment}, ` +
        `competition=${snap.competitiveIntensity}, seasonal=${snap.seasonalRelevance.toFixed(2)}, ` +
        `regulatory=${snap.regulatoryRisk}`,
      )
      .join('\n');

    if (!snapshots) return [];

    const prompt = `Analyze current market conditions and suggest 0-3 advisories.

=== Market Conditions ===
${snapshots}

=== Active Advisories Count ===
${this.getActiveAdvisories().length} active

Respond with JSON array:
[{
  "type": "market_opportunity|regulatory_alert|competitive_threat|seasonal_prep",
  "severity": "info|warning|critical",
  "title": "short title",
  "description": "brief description",
  "countryCodes": ["AR","BR",...],
  "recommendedActions": ["action1", "action2"],
  "formulaOverrides": {"key": "value"},
  "confidenceScore": 0.0-1.0
}]

If no advisories warranted, respond: []`;

    const raw = await callGemini(
      'You are ATLAS, the geopolitical intelligence engine for a global e-commerce operation across LATAM + Europe. Provide actionable market intelligence. Respond ONLY with valid JSON.',
      prompt,
    );

    if (!raw) return [];

    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return [];

      const parsed = JSON.parse(match[0]) as Array<{
        type: string;
        severity: string;
        title: string;
        description: string;
        countryCodes: string[];
        recommendedActions: string[];
        formulaOverrides: Record<string, unknown>;
        confidenceScore: number;
      }>;

      if (!Array.isArray(parsed) || parsed.length === 0) return [];

      return parsed.slice(0, 3).map(p => ({
        id: uuidv4(),
        type: this.validateAdvisoryType(p.type),
        status: 'assessed' as AdvisoryStatus,
        severity: this.validateSeverity(p.severity),
        title: (p.title ?? 'Untitled advisory').slice(0, 200),
        description: (p.description ?? '').slice(0, 1000),
        countryCodes: this.validateCountryCodes(p.countryCodes),
        signals: [],
        recommendedActions: Array.isArray(p.recommendedActions) ? p.recommendedActions.slice(0, 5) : [],
        formulaVariableOverrides: typeof p.formulaOverrides === 'object' ? p.formulaOverrides : {},
        confidenceScore: Math.max(0, Math.min(1, p.confidenceScore ?? 0.5)),
        expiresAt: new Date(Date.now() + this.config.advisoryTtlDays * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
        assessedAt: new Date(),
        publishedAt: null,
        actedOnAt: null,
        archivedAt: null,
      }));
    } catch (err) {
      log.warn({ err }, 'Failed to parse Gemini advisory response');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Currency Fluctuation Detection
  // ---------------------------------------------------------------------------

  private async detectCurrencyFluctuations(): Promise<WorldAdvisory[]> {
    const pool = getPool();
    if (!pool) return [];

    const advisories: WorldAdvisory[] = [];

    try {
      // Compare current vs 7-day-old exchange rates
      const { rows } = await pool.query(
        `SELECT ci.country_code, ci.exchange_rate_to_usd, ci.currency
         FROM meow_country_intelligence ci
         WHERE ci.country_code != 'EC'`,   // EC uses USD — no FX risk
      );

      for (const r of rows as Array<Record<string, unknown>>) {
        const code = r.country_code as MarketCode;
        const rate = parseFloat(String(r.exchange_rate_to_usd ?? '0'));
        const snapshot = this.conditionSnapshots.get(code);

        // Without historical comparison, flag abnormal rates heuristically
        if (rate <= 0) continue;

        // Check for already existing currency advisory
        const existing = this.advisories.some(
          a =>
            a.type === 'market_opportunity' &&
            a.countryCodes.includes(code) &&
            a.title.toLowerCase().includes('currency') &&
            a.status !== 'archived',
        );

        if (existing) continue;

        // Simple heuristic: if sentiment is bearish, it might be currency-related
        if (snapshot && snapshot.overallSentiment === 'bearish') {
          advisories.push({
            id: uuidv4(),
            type: 'market_opportunity',
            status: 'detected',
            severity: 'info',
            title: `${code} market showing bearish signals — review ${r.currency} exposure`,
            description: `Market ${MARKET_NAMES[code]} sentiment is bearish. Current exchange rate: ${rate} USD. Consider adjusting pricing or budget allocation.`,
            countryCodes: [code],
            signals: [{
              source: 'exchange_rate_monitor',
              signalType: 'currency_sentiment',
              value: rate,
              detectedAt: new Date(),
              reliability: 0.6,
            }],
            recommendedActions: [
              `Review pricing in ${r.currency}`,
              `Consider hedging ${code} ad spend`,
              `Monitor exchange rate trends`,
            ],
            formulaVariableOverrides: {
              [`${code.toLowerCase()}_fx_alert`]: true,
              [`${code.toLowerCase()}_exchange_rate`]: rate,
            },
            confidenceScore: 0.5,
            expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
            createdAt: new Date(),
            assessedAt: null,
            publishedAt: null,
            actedOnAt: null,
            archivedAt: null,
          });
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to detect currency fluctuations');
    }

    return advisories;
  }

  // ---------------------------------------------------------------------------
  // Private: Advisory Assessment
  // ---------------------------------------------------------------------------

  private async assessAdvisory(
    advisory: WorldAdvisory,
  ): Promise<{
    recommendedActions: string[];
    formulaVariableOverrides: Record<string, unknown>;
    confidenceScore: number;
  } | null> {
    const prompt = `Assess this market advisory and provide recommended actions.

Type: ${advisory.type}
Title: ${advisory.title}
Description: ${advisory.description}
Countries: ${advisory.countryCodes.join(', ')}
Severity: ${advisory.severity}

Respond with JSON:
{
  "recommendedActions": ["action1", "action2", "action3"],
  "formulaOverrides": {"variable_name": "value"},
  "confidenceScore": 0.0-1.0
}`;

    const raw = await callGemini(
      'You are ATLAS market advisory assessment engine. Provide actionable recommendations for e-commerce operations. Respond ONLY with valid JSON.',
      prompt,
    );

    if (!raw) return null;

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;

      const parsed = JSON.parse(match[0]) as {
        recommendedActions: string[];
        formulaOverrides: Record<string, unknown>;
        confidenceScore: number;
      };

      return {
        recommendedActions: Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions.slice(0, 5) : [],
        formulaVariableOverrides: typeof parsed.formulaOverrides === 'object' ? parsed.formulaOverrides : {},
        confidenceScore: Math.max(0, Math.min(1, parsed.confidenceScore ?? 0.5)),
      };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Filtering
  // ---------------------------------------------------------------------------

  private filterNovelAdvisories(proposed: WorldAdvisory[]): WorldAdvisory[] {
    const active = this.getActiveAdvisories();
    return proposed.filter(p => {
      const dup = active.some(
        a => a.type === p.type && this.titleOverlap(a.title, p.title) > 0.6,
      );
      return !dup;
    });
  }

  private titleOverlap(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const inter = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? inter.size / union.size : 0;
  }

  // ---------------------------------------------------------------------------
  // Private: Auto-Archive
  // ---------------------------------------------------------------------------

  private async archiveExpired(): Promise<void> {
    const now = new Date();
    for (const advisory of this.advisories) {
      if (advisory.status === 'archived') continue;
      if (advisory.expiresAt && advisory.expiresAt < now) {
        advisory.status = 'archived';
        advisory.archivedAt = now;
        await this.updateAdvisoryStatus(advisory).catch(err =>
          log.warn({ err, id: advisory.id }, 'Failed to auto-archive advisory'),
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Validation Helpers
  // ---------------------------------------------------------------------------

  private validateAdvisoryType(raw: string): AdvisoryType {
    const valid: AdvisoryType[] = ['market_opportunity', 'regulatory_alert', 'competitive_threat', 'seasonal_prep'];
    return valid.includes(raw as AdvisoryType) ? (raw as AdvisoryType) : 'market_opportunity';
  }

  private validateSeverity(raw: string): AdvisorySeverity {
    const valid: AdvisorySeverity[] = ['info', 'warning', 'critical'];
    return valid.includes(raw as AdvisorySeverity) ? (raw as AdvisorySeverity) : 'info';
  }

  private validateCountryCodes(raw: unknown): MarketCode[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(c => ALL_MARKETS.includes(c as MarketCode)) as MarketCode[];
  }

  // ---------------------------------------------------------------------------
  // Private: Persistence
  // ---------------------------------------------------------------------------

  private async persistAdvisory(advisory: WorldAdvisory): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_world_advisories
          (id, advisory_type, status, severity, title, description,
           country_codes, signals, recommended_actions,
           formula_variable_overrides, confidence_score,
           expires_at, created_at, assessed_at, published_at,
           acted_on_at, archived_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO NOTHING`,
        [
          advisory.id,
          advisory.type,
          advisory.status,
          advisory.severity,
          advisory.title.slice(0, 500),
          advisory.description.slice(0, 2000),
          JSON.stringify(advisory.countryCodes),
          JSON.stringify(advisory.signals),
          JSON.stringify(advisory.recommendedActions),
          JSON.stringify(advisory.formulaVariableOverrides),
          advisory.confidenceScore,
          advisory.expiresAt?.toISOString() ?? null,
          advisory.createdAt.toISOString(),
          advisory.assessedAt?.toISOString() ?? null,
          advisory.publishedAt?.toISOString() ?? null,
          advisory.actedOnAt?.toISOString() ?? null,
          advisory.archivedAt?.toISOString() ?? null,
          advisory.metadata ? JSON.stringify(advisory.metadata) : null,
        ],
      );
    } catch (err) {
      log.error({ err, advisoryId: advisory.id }, 'Failed to persist world advisory');
    }
  }

  private async updateAdvisoryStatus(advisory: WorldAdvisory): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_world_advisories
         SET status = $1, assessed_at = $2, published_at = $3,
             acted_on_at = $4, archived_at = $5, metadata = $6
         WHERE id = $7`,
        [
          advisory.status,
          advisory.assessedAt?.toISOString() ?? null,
          advisory.publishedAt?.toISOString() ?? null,
          advisory.actedOnAt?.toISOString() ?? null,
          advisory.archivedAt?.toISOString() ?? null,
          advisory.metadata ? JSON.stringify(advisory.metadata) : null,
          advisory.id,
        ],
      );
    } catch (err) {
      log.error({ err, advisoryId: advisory.id }, 'Failed to update advisory status');
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

let instance: AtlasWorldAdvisor | null = null;

export function getAtlasWorldAdvisor(
  config?: Partial<AtlasWorldConfig>,
): AtlasWorldAdvisor {
  if (!instance) {
    instance = new AtlasWorldAdvisor(config);
    log.info('AtlasWorldAdvisor singleton created');
  }
  return instance;
}

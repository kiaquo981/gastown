/**
 * GAS TOWN ECOMMERCE ADAPTER -- SG-006 (Stage 06 Wave 2)
 *
 * Dedicated Gas Town instance for global ecommerce operations.
 * Manages brand-focused ecommerce across EU + US markets.
 *
 * Features:
 *   - EU + US markets: ES, PT, US, UK, DE, FR
 *   - Brand-focused (not COD): proper brand building, Meta/Google Ads, Shopify stores
 *   - Multi-platform ads: Meta, Google, TikTok
 *   - Own worker pool: specialized in brand ops, creative, ads management
 *   - Own formula set: brand-launch, multi-platform-campaign, content-batch, performance-audit
 *   - Budget isolation: separate from regional instance
 *   - Metrics: ROAS, CPA, brand awareness, customer LTV, per-platform breakdown
 *   - Instance config: platforms, budgets, worker specializations
 *
 * Gas Town: "Global markets demand brands, not drops. Build empires, not orders."
 */

import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('gastown-ecommerce-adapter');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GlobalMarket = 'ES' | 'PT' | 'US' | 'UK' | 'DE' | 'FR';

export type AdsPlatform = 'meta' | 'google' | 'tiktok';

export type EcomGlobalFormulaName =
  | 'brand-launch'
  | 'multi-platform-campaign'
  | 'content-batch'
  | 'performance-audit'
  | 'creative-testing'
  | 'audience-expansion'
  | 'retargeting-funnel';

export type InstanceStatus = 'idle' | 'running' | 'paused' | 'error' | 'draining';

export type GlobalWorkerSpec =
  | 'brand-strategist'
  | 'ads-manager'
  | 'creative-director'
  | 'data-analyst'
  | 'shopify-ops'
  | 'copywriter'
  | 'market-researcher';

export interface GlobalWorker {
  id: string;
  name: string;
  specialization: GlobalWorkerSpec;
  assignedMarkets: GlobalMarket[];
  assignedPlatforms: AdsPlatform[];
  taskCount: number;
  successRate: number;
  borrowed: boolean;
  borrowedFrom?: string;
  createdAt: Date;
}

export interface PlatformMetrics {
  platform: AdsPlatform;
  market: GlobalMarket;
  spendUsd: number;
  revenue: number;
  roas: number;                  // return on ad spend
  cpa: number;                   // cost per acquisition
  impressions: number;
  clicks: number;
  ctr: number;                   // click-through rate
  conversions: number;
  conversionRate: number;
  cpc: number;                   // cost per click
  updatedAt: Date;
}

export interface MarketMetrics {
  market: GlobalMarket;
  totalRevenueUsd: number;
  totalSpendUsd: number;
  blendedRoas: number;
  avgCpa: number;
  customerLtv: number;
  brandAwarenessScore: number;   // 0 - 100
  storeConversionRate: number;
  avgOrderValue: number;
  repeatCustomerRate: number;
  activeCampaigns: number;
  activeProducts: number;
  platformBreakdown: PlatformMetrics[];
  updatedAt: Date;
}

export interface EcomGlobalBudget {
  id: string;
  monthlyLimitUsd: number;
  spentUsd: number;
  utilizationPct: number;
  perMarketLimits: Partial<Record<GlobalMarket, number>>;
  perMarketSpent: Partial<Record<GlobalMarket, number>>;
  perPlatformSpent: Partial<Record<AdsPlatform, number>>;
  adsSpendUsd: number;
  toolsSpendUsd: number;
  shopifySpendUsd: number;
  period: string;
  updatedAt: Date;
}

export interface EcomGlobalInstanceConfig {
  defaultFormulas: EcomGlobalFormulaName[];
  workerAllocation: Partial<Record<GlobalWorkerSpec, number>>;
  budgetLimitUsd: number;
  marketPriorities: GlobalMarket[];
  platforms: AdsPlatform[];
  targetRoas: number;
  maxCpa: number;
  maxConcurrentMolecules: number;
  borrowWorkersEnabled: boolean;
  borrowSourceInstances: string[];
}

export interface CampaignPerformance {
  id: string;
  campaignName: string;
  platform: AdsPlatform;
  market: GlobalMarket;
  status: 'active' | 'paused' | 'completed' | 'learning';
  spend: number;
  revenue: number;
  roas: number;
  cpa: number;
  impressions: number;
  conversions: number;
  startedAt: Date;
  updatedAt: Date;
}

export interface InstanceEvent {
  id: string;
  instanceId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface EcomGlobalStats {
  status: InstanceStatus;
  totalWorkers: number;
  borrowedWorkers: number;
  activeMolecules: number;
  totalMoleculesRun: number;
  marketsActive: number;
  totalRevenueUsd: number;
  totalSpendUsd: number;
  blendedRoas: number;
  avgCpa: number;
  activeCampaigns: number;
  budgetUtilizationPct: number;
  platformBreakdown: Record<AdsPlatform, { spend: number; revenue: number; roas: number }>;
  formulasExecuted: Record<string, number>;
  upSince: Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GLOBAL_MARKETS: GlobalMarket[] = ['ES', 'PT', 'US', 'UK', 'DE', 'FR'];
const ADS_PLATFORMS: AdsPlatform[] = ['meta', 'google', 'tiktok'];

const DEFAULT_CONFIG: EcomGlobalInstanceConfig = {
  defaultFormulas: ['brand-launch', 'multi-platform-campaign', 'content-batch', 'performance-audit'],
  workerAllocation: {
    'brand-strategist': 1,
    'ads-manager': 3,
    'creative-director': 1,
    'data-analyst': 2,
    'shopify-ops': 1,
    'copywriter': 2,
    'market-researcher': 1,
  },
  budgetLimitUsd: 5000,
  marketPriorities: ['US', 'UK', 'DE', 'ES', 'PT', 'FR'],
  platforms: ['meta', 'google', 'tiktok'],
  targetRoas: 3.0,
  maxCpa: 25,
  maxConcurrentMolecules: 20,
  borrowWorkersEnabled: true,
  borrowSourceInstances: ['content-factory'],
};

const DEFAULT_FORMULAS: Record<EcomGlobalFormulaName, {
  description: string;
  requiredSpecializations: GlobalWorkerSpec[];
  avgDurationMs: number;
}> = {
  'brand-launch': {
    description: 'Launch new brand: store setup, creative suite, initial campaigns, brand guidelines',
    requiredSpecializations: ['brand-strategist', 'shopify-ops', 'creative-director'],
    avgDurationMs: 7_200_000,
  },
  'multi-platform-campaign': {
    description: 'Create and launch campaigns across Meta + Google + TikTok simultaneously',
    requiredSpecializations: ['ads-manager', 'copywriter', 'data-analyst'],
    avgDurationMs: 3_600_000,
  },
  'content-batch': {
    description: 'Produce batch of creatives: videos, carousels, static images for all platforms',
    requiredSpecializations: ['creative-director', 'copywriter'],
    avgDurationMs: 2_400_000,
  },
  'performance-audit': {
    description: 'Deep analysis of campaign performance with AI recommendations',
    requiredSpecializations: ['data-analyst', 'ads-manager'],
    avgDurationMs: 1_800_000,
  },
  'creative-testing': {
    description: 'A/B test creative variants across platforms with statistical significance',
    requiredSpecializations: ['data-analyst', 'creative-director'],
    avgDurationMs: 2_400_000,
  },
  'audience-expansion': {
    description: 'Discover and test new audiences using lookalikes, interests, and AI targeting',
    requiredSpecializations: ['ads-manager', 'market-researcher'],
    avgDurationMs: 1_500_000,
  },
  'retargeting-funnel': {
    description: 'Build multi-stage retargeting funnel: view → add to cart → purchase → repeat',
    requiredSpecializations: ['ads-manager', 'data-analyst'],
    avgDurationMs: 1_200_000,
  },
};

const MAX_EVENTS = 2000;
const MAX_WORKERS = 50;
const MAX_CAMPAIGNS = 500;

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
                'You are a performance marketing strategist specializing in multi-platform brand advertising '
                + 'across EU and US markets. Respond ONLY with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1536,
          temperature: 0.3,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in gastown-ecommerce-adapter');
    return null;
  }
}

// ---------------------------------------------------------------------------
// GasTownEcomGlobal
// ---------------------------------------------------------------------------

export class GasTownEcomGlobal {
  readonly instanceId: string;
  private status: InstanceStatus = 'idle';
  private config: EcomGlobalInstanceConfig;
  private workers = new Map<string, GlobalWorker>();
  private marketMetrics = new Map<GlobalMarket, MarketMetrics>();
  private campaigns = new Map<string, CampaignPerformance>();
  private budget: EcomGlobalBudget;
  private events: InstanceEvent[] = [];
  private activeMoleculeIds = new Set<string>();
  private formulaExecutions = new Map<string, number>();
  private upSince: Date;

  constructor(config?: Partial<EcomGlobalInstanceConfig>) {
    this.instanceId = `ecom-global-${process.env.MEOW_INSTANCE_ID || os.hostname().slice(0, 8) || 'default'}`;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.upSince = new Date();

    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    this.budget = {
      id: uuidv4(),
      monthlyLimitUsd: this.config.budgetLimitUsd,
      spentUsd: 0,
      utilizationPct: 0,
      perMarketLimits: {},
      perMarketSpent: {},
      perPlatformSpent: {},
      adsSpendUsd: 0,
      toolsSpendUsd: 0,
      shopifySpendUsd: 0,
      period,
      updatedAt: now,
    };

    // Initialize market metrics
    for (const market of GLOBAL_MARKETS) {
      this.marketMetrics.set(market, {
        market,
        totalRevenueUsd: 0,
        totalSpendUsd: 0,
        blendedRoas: 0,
        avgCpa: 0,
        customerLtv: 0,
        brandAwarenessScore: 0,
        storeConversionRate: 0,
        avgOrderValue: 0,
        repeatCustomerRate: 0,
        activeCampaigns: 0,
        activeProducts: 0,
        platformBreakdown: [],
        updatedAt: now,
      });
    }

    log.info({ instanceId: this.instanceId, config: this.config }, 'EcomGlobal instance created');
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    if (this.status === 'running') return;

    this.status = 'running';
    this.upSince = new Date();

    await this.provisionWorkers();
    await this.loadFromDb();

    this.emitEvent('instance_started', { config: this.config });

    broadcast('meow:sovereign', {
      type: 'ecom_global_started',
      instanceId: this.instanceId,
      markets: GLOBAL_MARKETS,
      platforms: ADS_PLATFORMS,
      workerCount: this.workers.size,
    });

    log.info({ instanceId: this.instanceId }, 'EcomGlobal instance started');
  }

  async stop(): Promise<void> {
    this.status = 'draining';

    const drainStart = Date.now();
    while (this.activeMoleculeIds.size > 0 && Date.now() - drainStart < 30_000) {
      await new Promise(r => setTimeout(r, 1000));
    }

    this.status = 'idle';
    await this.persistState();

    this.emitEvent('instance_stopped', {
      totalMolecules: this.formulaExecutions.size,
      drained: this.activeMoleculeIds.size === 0,
    });

    broadcast('meow:sovereign', { type: 'ecom_global_stopped', instanceId: this.instanceId });
    log.info({ instanceId: this.instanceId }, 'EcomGlobal instance stopped');
  }

  pause(): void {
    this.status = 'paused';
    this.emitEvent('instance_paused', {});
    broadcast('meow:sovereign', { type: 'ecom_global_paused', instanceId: this.instanceId });
  }

  resume(): void {
    this.status = 'running';
    this.emitEvent('instance_resumed', {});
    broadcast('meow:sovereign', { type: 'ecom_global_resumed', instanceId: this.instanceId });
  }

  getStatus(): InstanceStatus {
    return this.status;
  }

  // --- Worker management -----------------------------------------------------

  async provisionWorkers(): Promise<void> {
    for (const [spec, count] of Object.entries(this.config.workerAllocation)) {
      const specialization = spec as GlobalWorkerSpec;
      const existingCount = Array.from(this.workers.values())
        .filter(w => w.specialization === specialization && !w.borrowed).length;

      for (let i = existingCount; i < (count ?? 0); i++) {
        if (this.workers.size >= MAX_WORKERS) break;
        const worker: GlobalWorker = {
          id: uuidv4(),
          name: `global-${specialization}-${i + 1}`,
          specialization,
          assignedMarkets: [],
          assignedPlatforms: [],
          taskCount: 0,
          successRate: 1.0,
          borrowed: false,
          createdAt: new Date(),
        };
        this.workers.set(worker.id, worker);
      }
    }

    log.info({ workerCount: this.workers.size }, 'Workers provisioned for EcomGlobal');
  }

  addWorker(worker: GlobalWorker): void {
    if (this.workers.size >= MAX_WORKERS) {
      log.warn('Worker limit reached');
      return;
    }
    this.workers.set(worker.id, worker);
    this.emitEvent('worker_added', { workerId: worker.id, specialization: worker.specialization });
  }

  removeWorker(workerId: string): boolean {
    const removed = this.workers.delete(workerId);
    if (removed) this.emitEvent('worker_removed', { workerId });
    return removed;
  }

  borrowWorker(workerId: string, sourceInstance: string): GlobalWorker | null {
    if (!this.config.borrowWorkersEnabled || this.workers.size >= MAX_WORKERS) return null;

    const borrowed: GlobalWorker = {
      id: workerId,
      name: `borrowed-${sourceInstance}-${workerId.slice(0, 8)}`,
      specialization: 'copywriter',
      assignedMarkets: [],
      assignedPlatforms: [],
      taskCount: 0,
      successRate: 1.0,
      borrowed: true,
      borrowedFrom: sourceInstance,
      createdAt: new Date(),
    };

    this.workers.set(borrowed.id, borrowed);
    this.emitEvent('worker_borrowed', { workerId, sourceInstance });

    broadcast('meow:sovereign', {
      type: 'ecom_global_worker_borrowed',
      instanceId: this.instanceId,
      workerId,
      sourceInstance,
    });

    return borrowed;
  }

  returnBorrowedWorker(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker || !worker.borrowed) return false;
    this.workers.delete(workerId);
    this.emitEvent('worker_returned', { workerId, toInstance: worker.borrowedFrom });
    return true;
  }

  getAvailableWorkers(spec?: GlobalWorkerSpec): GlobalWorker[] {
    return Array.from(this.workers.values()).filter(w => !spec || w.specialization === spec);
  }

  // --- Campaign management ---------------------------------------------------

  registerCampaign(campaign: Omit<CampaignPerformance, 'id' | 'updatedAt'>): CampaignPerformance {
    const full: CampaignPerformance = {
      ...campaign,
      id: uuidv4(),
      updatedAt: new Date(),
    };

    this.campaigns.set(full.id, full);
    if (this.campaigns.size > MAX_CAMPAIGNS) {
      const oldest = Array.from(this.campaigns.entries())
        .sort((a, b) => a[1].updatedAt.getTime() - b[1].updatedAt.getTime())[0];
      if (oldest) this.campaigns.delete(oldest[0]);
    }

    this.emitEvent('campaign_registered', { campaignId: full.id, platform: full.platform, market: full.market });

    broadcast('meow:sovereign', {
      type: 'ecom_global_campaign_registered',
      instanceId: this.instanceId,
      campaignId: full.id,
      platform: full.platform,
      market: full.market,
    });

    return full;
  }

  updateCampaignPerformance(campaignId: string, update: Partial<CampaignPerformance>): void {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return;

    Object.assign(campaign, update, { updatedAt: new Date() });

    // Recalculate ROAS
    if (campaign.spend > 0) {
      campaign.roas = Math.round((campaign.revenue / campaign.spend) * 100) / 100;
    }
    if (campaign.conversions > 0) {
      campaign.cpa = Math.round((campaign.spend / campaign.conversions) * 100) / 100;
    }

    // Check performance thresholds
    if (campaign.roas < this.config.targetRoas * 0.5 && campaign.spend > 50) {
      broadcast('meow:sovereign', {
        type: 'ecom_global_campaign_underperforming',
        instanceId: this.instanceId,
        campaignId,
        roas: campaign.roas,
        targetRoas: this.config.targetRoas,
      });
    }

    if (campaign.cpa > this.config.maxCpa && campaign.conversions >= 3) {
      broadcast('meow:sovereign', {
        type: 'ecom_global_campaign_high_cpa',
        instanceId: this.instanceId,
        campaignId,
        cpa: campaign.cpa,
        maxCpa: this.config.maxCpa,
      });
    }
  }

  getCampaignsByPlatform(platform: AdsPlatform): CampaignPerformance[] {
    return Array.from(this.campaigns.values()).filter(c => c.platform === platform);
  }

  getCampaignsByMarket(market: GlobalMarket): CampaignPerformance[] {
    return Array.from(this.campaigns.values()).filter(c => c.market === market);
  }

  getActiveCampaigns(): CampaignPerformance[] {
    return Array.from(this.campaigns.values()).filter(c => c.status === 'active' || c.status === 'learning');
  }

  // --- Molecule lifecycle ----------------------------------------------------

  registerMolecule(moleculeId: string, formulaName: EcomGlobalFormulaName): void {
    if (this.status !== 'running') return;
    if (this.activeMoleculeIds.size >= this.config.maxConcurrentMolecules) return;

    this.activeMoleculeIds.add(moleculeId);
    this.formulaExecutions.set(formulaName, (this.formulaExecutions.get(formulaName) ?? 0) + 1);

    this.emitEvent('molecule_registered', { moleculeId, formulaName });

    broadcast('meow:sovereign', {
      type: 'ecom_global_molecule_registered',
      instanceId: this.instanceId,
      moleculeId,
      formulaName,
      activeMolecules: this.activeMoleculeIds.size,
    });
  }

  completeMolecule(moleculeId: string, success: boolean): void {
    this.activeMoleculeIds.delete(moleculeId);
    this.emitEvent('molecule_completed', { moleculeId, success });
  }

  // --- Market metrics --------------------------------------------------------

  updateMarketMetrics(market: GlobalMarket, update: Partial<MarketMetrics>): void {
    const existing = this.marketMetrics.get(market);
    if (!existing) return;

    Object.assign(existing, update, { updatedAt: new Date() });

    // Recalculate blended ROAS
    if (existing.totalSpendUsd > 0) {
      existing.blendedRoas = Math.round((existing.totalRevenueUsd / existing.totalSpendUsd) * 100) / 100;
    }

    this.emitEvent('market_metrics_updated', { market, ...update });

    broadcast('meow:sovereign', {
      type: 'ecom_global_market_updated',
      instanceId: this.instanceId,
      market,
      revenue: existing.totalRevenueUsd,
      spend: existing.totalSpendUsd,
      blendedRoas: existing.blendedRoas,
    });
  }

  getMarketMetrics(market: GlobalMarket): MarketMetrics | null {
    return this.marketMetrics.get(market) ?? null;
  }

  getAllMarketMetrics(): MarketMetrics[] {
    return Array.from(this.marketMetrics.values());
  }

  // --- Budget management -----------------------------------------------------

  recordSpend(amount: number, market?: GlobalMarket, platform?: AdsPlatform, category?: 'ads' | 'tools' | 'shopify'): void {
    this.budget.spentUsd += amount;
    this.budget.utilizationPct = this.budget.monthlyLimitUsd > 0
      ? (this.budget.spentUsd / this.budget.monthlyLimitUsd) * 100
      : 0;

    if (market) {
      this.budget.perMarketSpent[market] = (this.budget.perMarketSpent[market] ?? 0) + amount;
    }
    if (platform) {
      this.budget.perPlatformSpent[platform] = (this.budget.perPlatformSpent[platform] ?? 0) + amount;
    }

    if (category === 'ads') this.budget.adsSpendUsd += amount;
    else if (category === 'tools') this.budget.toolsSpendUsd += amount;
    else if (category === 'shopify') this.budget.shopifySpendUsd += amount;

    this.budget.updatedAt = new Date();

    if (this.budget.utilizationPct >= 90) {
      broadcast('meow:sovereign', {
        type: 'ecom_global_budget_critical',
        instanceId: this.instanceId,
        utilizationPct: Math.round(this.budget.utilizationPct * 10) / 10,
        spentUsd: Math.round(this.budget.spentUsd * 100) / 100,
      });
    }
  }

  checkBudget(estimatedCostUsd: number): { allowed: boolean; reason?: string } {
    const projected = this.budget.spentUsd + estimatedCostUsd;
    const projectedPct = this.budget.monthlyLimitUsd > 0
      ? (projected / this.budget.monthlyLimitUsd) * 100
      : 0;

    if (projectedPct >= 100) {
      return {
        allowed: false,
        reason: `Budget exceeded: $${projected.toFixed(2)} / $${this.budget.monthlyLimitUsd} (${projectedPct.toFixed(1)}%)`,
      };
    }
    return { allowed: true };
  }

  getBudget(): EcomGlobalBudget {
    return { ...this.budget };
  }

  // --- AI-powered performance analysis ---------------------------------------

  async analyzePerformance(): Promise<{
    summary: string;
    topPerformers: string[];
    underperformers: string[];
    recommendations: string[];
    overallScore: number;
  }> {
    const activeCampaigns = this.getActiveCampaigns();
    const marketData = this.getAllMarketMetrics();

    const prompt = `Analyze multi-platform ad performance across EU + US markets:

Markets: ${marketData.map(m => `${m.market}: revenue=$${m.totalRevenueUsd}, spend=$${m.totalSpendUsd}, ROAS=${m.blendedRoas}`).join('; ')}

Active campaigns (${activeCampaigns.length}):
${activeCampaigns.slice(0, 10).map(c => `- ${c.campaignName} (${c.platform}/${c.market}): ROAS=${c.roas}, CPA=$${c.cpa}, spend=$${c.spend}`).join('\n')}

Target ROAS: ${this.config.targetRoas}, Max CPA: $${this.config.maxCpa}

Respond JSON: {"summary":"string","topPerformers":["string"],"underperformers":["string"],"recommendations":["string"],"overallScore":0-100}`;

    const raw = await callGemini(prompt);
    if (raw) {
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as {
            summary: string;
            topPerformers: string[];
            underperformers: string[];
            recommendations: string[];
            overallScore: number;
          };
          return {
            summary: parsed.summary ?? 'Analysis complete',
            topPerformers: Array.isArray(parsed.topPerformers) ? parsed.topPerformers : [],
            underperformers: Array.isArray(parsed.underperformers) ? parsed.underperformers : [],
            recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
            overallScore: Math.max(0, Math.min(100, parsed.overallScore ?? 50)),
          };
        }
      } catch {
        log.warn('Failed to parse AI performance analysis');
      }
    }

    // Heuristic fallback
    const totalRevenue = marketData.reduce((s, m) => s + m.totalRevenueUsd, 0);
    const totalSpend = marketData.reduce((s, m) => s + m.totalSpendUsd, 0);
    const overallRoas = totalSpend > 0 ? totalRevenue / totalSpend : 0;

    const topPerformers = activeCampaigns
      .filter(c => c.roas >= this.config.targetRoas)
      .map(c => `${c.campaignName} (ROAS: ${c.roas})`);
    const underperformers = activeCampaigns
      .filter(c => c.roas < this.config.targetRoas * 0.5 && c.spend > 20)
      .map(c => `${c.campaignName} (ROAS: ${c.roas})`);

    const recommendations: string[] = [];
    if (overallRoas < this.config.targetRoas) recommendations.push('Overall ROAS below target - review underperforming campaigns');
    if (underperformers.length > activeCampaigns.length * 0.3) recommendations.push('Too many underperformers - consolidate ad spend');
    if (this.budget.utilizationPct > 80) recommendations.push('Budget utilization high - prioritize best performers');

    const score = Math.round(Math.min(100, (overallRoas / this.config.targetRoas) * 50 + (topPerformers.length / Math.max(1, activeCampaigns.length)) * 50));

    return {
      summary: `Overall ROAS: ${overallRoas.toFixed(2)}, ${activeCampaigns.length} active campaigns, ${topPerformers.length} above target`,
      topPerformers: topPerformers.slice(0, 5),
      underperformers: underperformers.slice(0, 5),
      recommendations,
      overallScore: score,
    };
  }

  // --- Formulas --------------------------------------------------------------

  getAvailableFormulas(): typeof DEFAULT_FORMULAS {
    return { ...DEFAULT_FORMULAS };
  }

  getFormulaInfo(name: EcomGlobalFormulaName): typeof DEFAULT_FORMULAS[EcomGlobalFormulaName] | null {
    return DEFAULT_FORMULAS[name] ?? null;
  }

  // --- Config ----------------------------------------------------------------

  getConfig(): EcomGlobalInstanceConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<EcomGlobalInstanceConfig>): void {
    this.config = { ...this.config, ...updates };
    this.emitEvent('config_updated', { updates });
    log.info({ updates }, 'EcomGlobal config updated');
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): EcomGlobalStats {
    const allMetrics = this.getAllMarketMetrics();
    const totalRevenue = allMetrics.reduce((s, m) => s + m.totalRevenueUsd, 0);
    const totalSpend = allMetrics.reduce((s, m) => s + m.totalSpendUsd, 0);
    const activeMarkets = allMetrics.filter(m => m.activeCampaigns > 0).length;
    const blendedRoas = totalSpend > 0 ? Math.round((totalRevenue / totalSpend) * 100) / 100 : 0;

    const activeCampaigns = this.getActiveCampaigns();
    const avgCpa = activeCampaigns.length > 0
      ? Math.round((activeCampaigns.reduce((s, c) => s + c.cpa, 0) / activeCampaigns.length) * 100) / 100
      : 0;

    const platformBreakdown: Record<AdsPlatform, { spend: number; revenue: number; roas: number }> = {} as any;
    for (const platform of ADS_PLATFORMS) {
      const platformCampaigns = this.getCampaignsByPlatform(platform);
      const pSpend = platformCampaigns.reduce((s, c) => s + c.spend, 0);
      const pRevenue = platformCampaigns.reduce((s, c) => s + c.revenue, 0);
      platformBreakdown[platform] = {
        spend: Math.round(pSpend * 100) / 100,
        revenue: Math.round(pRevenue * 100) / 100,
        roas: pSpend > 0 ? Math.round((pRevenue / pSpend) * 100) / 100 : 0,
      };
    }

    const borrowedCount = Array.from(this.workers.values()).filter(w => w.borrowed).length;

    return {
      status: this.status,
      totalWorkers: this.workers.size,
      borrowedWorkers: borrowedCount,
      activeMolecules: this.activeMoleculeIds.size,
      totalMoleculesRun: Array.from(this.formulaExecutions.values()).reduce((s, n) => s + n, 0),
      marketsActive: activeMarkets,
      totalRevenueUsd: Math.round(totalRevenue * 100) / 100,
      totalSpendUsd: Math.round(totalSpend * 100) / 100,
      blendedRoas,
      avgCpa,
      activeCampaigns: activeCampaigns.length,
      budgetUtilizationPct: Math.round(this.budget.utilizationPct * 10) / 10,
      platformBreakdown,
      formulasExecuted: Object.fromEntries(this.formulaExecutions),
      upSince: this.upSince,
    };
  }

  // --- Events ----------------------------------------------------------------

  getRecentEvents(limit = 50): InstanceEvent[] {
    return this.events.slice(-limit);
  }

  // --- Persistence -----------------------------------------------------------

  async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT market, total_revenue_usd, total_spend_usd, blended_roas,
                avg_cpa, customer_ltv, brand_awareness_score, store_conversion_rate,
                avg_order_value, repeat_customer_rate, active_campaigns, active_products,
                updated_at
         FROM meow_instance_ecom_global
         WHERE instance_id = $1
         ORDER BY updated_at DESC
         LIMIT 20`,
        [this.instanceId],
      );

      for (const r of rows as Array<Record<string, unknown>>) {
        const market = r.market as GlobalMarket;
        if (GLOBAL_MARKETS.includes(market)) {
          this.marketMetrics.set(market, {
            market,
            totalRevenueUsd: parseFloat(r.total_revenue_usd as string) || 0,
            totalSpendUsd: parseFloat(r.total_spend_usd as string) || 0,
            blendedRoas: parseFloat(r.blended_roas as string) || 0,
            avgCpa: parseFloat(r.avg_cpa as string) || 0,
            customerLtv: parseFloat(r.customer_ltv as string) || 0,
            brandAwarenessScore: parseFloat(r.brand_awareness_score as string) || 0,
            storeConversionRate: parseFloat(r.store_conversion_rate as string) || 0,
            avgOrderValue: parseFloat(r.avg_order_value as string) || 0,
            repeatCustomerRate: parseFloat(r.repeat_customer_rate as string) || 0,
            activeCampaigns: parseInt(r.active_campaigns as string) || 0,
            activeProducts: parseInt(r.active_products as string) || 0,
            platformBreakdown: [],
            updatedAt: new Date(r.updated_at as string),
          });
        }
      }

      log.info({ instanceId: this.instanceId, loaded: rows.length }, 'EcomGlobal state loaded from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load EcomGlobal state from DB');
    }
  }

  async persistState(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    for (const [market, metrics] of this.marketMetrics) {
      try {
        await pool.query(
          `INSERT INTO meow_instance_ecom_global
            (id, instance_id, market, total_revenue_usd, total_spend_usd, blended_roas,
             avg_cpa, customer_ltv, brand_awareness_score, store_conversion_rate,
             avg_order_value, repeat_customer_rate, active_campaigns, active_products,
             updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (instance_id, market) DO UPDATE SET
             total_revenue_usd = EXCLUDED.total_revenue_usd,
             total_spend_usd = EXCLUDED.total_spend_usd,
             blended_roas = EXCLUDED.blended_roas,
             avg_cpa = EXCLUDED.avg_cpa,
             customer_ltv = EXCLUDED.customer_ltv,
             brand_awareness_score = EXCLUDED.brand_awareness_score,
             store_conversion_rate = EXCLUDED.store_conversion_rate,
             avg_order_value = EXCLUDED.avg_order_value,
             repeat_customer_rate = EXCLUDED.repeat_customer_rate,
             active_campaigns = EXCLUDED.active_campaigns,
             active_products = EXCLUDED.active_products,
             updated_at = EXCLUDED.updated_at`,
          [
            uuidv4(), this.instanceId, market,
            metrics.totalRevenueUsd, metrics.totalSpendUsd, metrics.blendedRoas,
            metrics.avgCpa, metrics.customerLtv, metrics.brandAwarenessScore,
            metrics.storeConversionRate, metrics.avgOrderValue,
            metrics.repeatCustomerRate, metrics.activeCampaigns,
            metrics.activeProducts, metrics.updatedAt.toISOString(),
          ],
        );
      } catch (err) {
        log.warn({ err, market }, 'Failed to persist EcomGlobal market metrics');
      }
    }
  }

  // --- Private helpers -------------------------------------------------------

  private emitEvent(type: string, payload: Record<string, unknown>): void {
    const event: InstanceEvent = {
      id: uuidv4(),
      instanceId: this.instanceId,
      type,
      payload,
      createdAt: new Date(),
    };

    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: GasTownEcomGlobal | null = null;

export function getGasTownEcomGlobal(
  config?: Partial<EcomGlobalInstanceConfig>,
): GasTownEcomGlobal {
  if (!instance) {
    instance = new GasTownEcomGlobal(config);
    log.info('GasTownEcomGlobal singleton created');
  }
  return instance;
}

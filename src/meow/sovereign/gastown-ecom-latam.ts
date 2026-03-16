/**
 * GAS TOWN REGIONAL ADAPTER -- SG-005 (Stage 06 Wave 2)
 *
 * Dedicated Gas Town instance for regional ecommerce operations.
 * Manages COD-focused ecommerce across 7 LATAM countries.
 *
 * Features:
 *   - 7 LATAM countries: AR, BR, MX, CO, CL, PE, EC
 *   - COD (Cash on Delivery) focused operations
 *   - Own worker pool: dedicated crew members for LATAM tasks
 *   - Own formula set: country-expansion, fulfillment, WA-funnel, product-mining
 *   - Budget isolation: separate budget tracking from other instances
 *   - Metrics: GMV, orders, fulfillment rate, WA conversion, per-country breakdown
 *   - Cross-instance resource sharing: can borrow workers from Content Factory
 *   - Instance config: default formulas, worker allocation, budget limits, country priorities
 *
 * Gas Town: "Latin America runs on cash and hustle. Every country is a new rig."
 */

import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('gastown-regional-adapter');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LatamCountry = 'AR' | 'BR' | 'MX' | 'CO' | 'CL' | 'PE' | 'EC';

export type RegionalFormulaName =
  | 'country-expansion'
  | 'fulfillment'
  | 'wa-funnel'
  | 'product-mining'
  | 'cod-optimization'
  | 'supplier-sourcing'
  | 'local-ads';

export type InstanceStatus = 'idle' | 'running' | 'paused' | 'error' | 'draining';

export type WorkerSpecialization =
  | 'product-research'
  | 'fulfillment-ops'
  | 'wa-engagement'
  | 'supplier-mgmt'
  | 'ads-latam'
  | 'country-intel'
  | 'pricing';

export interface LatamWorker {
  id: string;
  name: string;
  specialization: WorkerSpecialization;
  assignedCountries: LatamCountry[];
  taskCount: number;
  successRate: number;
  borrowed: boolean;             // true if borrowed from another instance
  borrowedFrom?: string;         // source instance id
  createdAt: Date;
}

export interface CountryMetrics {
  country: LatamCountry;
  gmvUsd: number;
  orders: number;
  avgOrderValueUsd: number;
  fulfillmentRate: number;       // 0.0 - 1.0
  waConversionRate: number;      // 0.0 - 1.0
  activeProducts: number;
  activeSuppliers: number;
  returnRate: number;
  codCollectionRate: number;     // percentage of COD collected successfully
  updatedAt: Date;
}

export interface RegionalBudget {
  id: string;
  monthlyLimitUsd: number;
  spentUsd: number;
  utilizationPct: number;
  perCountryLimits: Partial<Record<LatamCountry, number>>;
  perCountrySpent: Partial<Record<LatamCountry, number>>;
  adsSpendUsd: number;
  fulfillmentSpendUsd: number;
  toolsSpendUsd: number;
  period: string;                // YYYY-MM
  updatedAt: Date;
}

export interface RegionalInstanceConfig {
  defaultFormulas: RegionalFormulaName[];
  workerAllocation: Partial<Record<WorkerSpecialization, number>>;
  budgetLimitUsd: number;
  countryPriorities: LatamCountry[];
  codEnabled: boolean;
  waFunnelEnabled: boolean;
  maxConcurrentMolecules: number;
  borrowWorkersEnabled: boolean;
  borrowSourceInstances: string[];
}

export interface InstanceEvent {
  id: string;
  instanceId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface RegionalStats {
  status: InstanceStatus;
  totalWorkers: number;
  borrowedWorkers: number;
  activeMolecules: number;
  totalMoleculesRun: number;
  countriesActive: number;
  totalGmvUsd: number;
  totalOrders: number;
  avgFulfillmentRate: number;
  avgWaConversion: number;
  budgetUtilizationPct: number;
  formulasExecuted: Record<string, number>;
  upSince: Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LATAM_COUNTRIES: LatamCountry[] = ['AR', 'BR', 'MX', 'CO', 'CL', 'PE', 'EC'];

const DEFAULT_CONFIG: RegionalInstanceConfig = {
  defaultFormulas: ['country-expansion', 'fulfillment', 'wa-funnel', 'product-mining'],
  workerAllocation: {
    'product-research': 2,
    'fulfillment-ops': 2,
    'wa-engagement': 2,
    'supplier-mgmt': 1,
    'ads-latam': 2,
    'country-intel': 1,
    'pricing': 1,
  },
  budgetLimitUsd: 2000,
  countryPriorities: ['AR', 'BR', 'MX', 'CO', 'CL', 'PE', 'EC'],
  codEnabled: true,
  waFunnelEnabled: true,
  maxConcurrentMolecules: 15,
  borrowWorkersEnabled: true,
  borrowSourceInstances: ['content-factory'],
};

const DEFAULT_FORMULAS: Record<RegionalFormulaName, {
  description: string;
  requiredSpecializations: WorkerSpecialization[];
  avgDurationMs: number;
}> = {
  'country-expansion': {
    description: 'Open new country market: suppliers, products, WA channels, payment setup',
    requiredSpecializations: ['country-intel', 'supplier-mgmt', 'wa-engagement'],
    avgDurationMs: 3_600_000,
  },
  'fulfillment': {
    description: 'Process COD orders: pick, pack, ship, COD collection tracking',
    requiredSpecializations: ['fulfillment-ops'],
    avgDurationMs: 1_200_000,
  },
  'wa-funnel': {
    description: 'WhatsApp funnel engagement: lead → conversation → order → post-sale',
    requiredSpecializations: ['wa-engagement'],
    avgDurationMs: 900_000,
  },
  'product-mining': {
    description: 'Discover winning products via trend analysis and competitor scraping',
    requiredSpecializations: ['product-research', 'country-intel'],
    avgDurationMs: 1_800_000,
  },
  'cod-optimization': {
    description: 'Optimize COD collection rates: address verification, delivery timing, re-attempts',
    requiredSpecializations: ['fulfillment-ops', 'pricing'],
    avgDurationMs: 600_000,
  },
  'supplier-sourcing': {
    description: 'Find and vet new suppliers per country with quality and margin criteria',
    requiredSpecializations: ['supplier-mgmt', 'country-intel'],
    avgDurationMs: 2_400_000,
  },
  'local-ads': {
    description: 'LATAM-specific ad campaigns with local copy, payment methods, and compliance',
    requiredSpecializations: ['ads-latam', 'pricing'],
    avgDurationMs: 1_500_000,
  },
};

const MAX_EVENTS = 2000;
const MAX_WORKERS = 50;

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
                'You are a LATAM ecommerce operations advisor specializing in COD markets. '
                + 'Respond ONLY with valid JSON.',
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
    log.warn({ err }, 'Gemini call failed in gastown-regional-adapter');
    return null;
  }
}

// ---------------------------------------------------------------------------
// GasTownRegional
// ---------------------------------------------------------------------------

export class GasTownRegional {
  readonly instanceId: string;
  private status: InstanceStatus = 'idle';
  private config: RegionalInstanceConfig;
  private workers = new Map<string, LatamWorker>();
  private countryMetrics = new Map<LatamCountry, CountryMetrics>();
  private budget: RegionalBudget;
  private events: InstanceEvent[] = [];
  private activeMoleculeIds = new Set<string>();
  private formulaExecutions = new Map<string, number>();
  private upSince: Date;

  constructor(config?: Partial<RegionalInstanceConfig>) {
    this.instanceId = `regional-${process.env.MEOW_INSTANCE_ID || os.hostname().slice(0, 8) || 'default'}`;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.upSince = new Date();

    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    this.budget = {
      id: uuidv4(),
      monthlyLimitUsd: this.config.budgetLimitUsd,
      spentUsd: 0,
      utilizationPct: 0,
      perCountryLimits: {},
      perCountrySpent: {},
      adsSpendUsd: 0,
      fulfillmentSpendUsd: 0,
      toolsSpendUsd: 0,
      period,
      updatedAt: now,
    };

    // Initialize country metrics
    for (const country of LATAM_COUNTRIES) {
      this.countryMetrics.set(country, {
        country,
        gmvUsd: 0,
        orders: 0,
        avgOrderValueUsd: 0,
        fulfillmentRate: 0,
        waConversionRate: 0,
        activeProducts: 0,
        activeSuppliers: 0,
        returnRate: 0,
        codCollectionRate: 0,
        updatedAt: now,
      });
    }

    log.info({ instanceId: this.instanceId, config: this.config }, 'Regional instance created');
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    if (this.status === 'running') return;

    this.status = 'running';
    this.upSince = new Date();

    // Provision default workers based on allocation config
    await this.provisionWorkers();

    // Load persisted state from DB
    await this.loadFromDb();

    this.emitEvent('instance_started', { config: this.config });

    broadcast('meow:sovereign', {
      type: 'regional_started',
      instanceId: this.instanceId,
      countries: LATAM_COUNTRIES,
      workerCount: this.workers.size,
    });

    log.info({ instanceId: this.instanceId }, 'Regional instance started');
  }

  async stop(): Promise<void> {
    this.status = 'draining';

    // Wait for active molecules to complete (with timeout)
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

    broadcast('meow:sovereign', {
      type: 'regional_stopped',
      instanceId: this.instanceId,
    });

    log.info({ instanceId: this.instanceId }, 'Regional instance stopped');
  }

  pause(): void {
    this.status = 'paused';
    this.emitEvent('instance_paused', {});
    broadcast('meow:sovereign', { type: 'regional_paused', instanceId: this.instanceId });
    log.info({ instanceId: this.instanceId }, 'Regional instance paused');
  }

  resume(): void {
    this.status = 'running';
    this.emitEvent('instance_resumed', {});
    broadcast('meow:sovereign', { type: 'regional_resumed', instanceId: this.instanceId });
    log.info({ instanceId: this.instanceId }, 'Regional instance resumed');
  }

  getStatus(): InstanceStatus {
    return this.status;
  }

  // --- Worker management -----------------------------------------------------

  async provisionWorkers(): Promise<void> {
    for (const [spec, count] of Object.entries(this.config.workerAllocation)) {
      const specialization = spec as WorkerSpecialization;
      const existingCount = Array.from(this.workers.values())
        .filter(w => w.specialization === specialization && !w.borrowed).length;

      for (let i = existingCount; i < (count ?? 0); i++) {
        if (this.workers.size >= MAX_WORKERS) break;
        const worker: LatamWorker = {
          id: uuidv4(),
          name: `latam-${specialization}-${i + 1}`,
          specialization,
          assignedCountries: [],
          taskCount: 0,
          successRate: 1.0,
          borrowed: false,
          createdAt: new Date(),
        };
        this.workers.set(worker.id, worker);
      }
    }

    log.info({ workerCount: this.workers.size }, 'Workers provisioned for Regional');
  }

  addWorker(worker: LatamWorker): void {
    if (this.workers.size >= MAX_WORKERS) {
      log.warn('Worker limit reached, cannot add more');
      return;
    }
    this.workers.set(worker.id, worker);
    this.emitEvent('worker_added', { workerId: worker.id, specialization: worker.specialization });
  }

  removeWorker(workerId: string): boolean {
    const removed = this.workers.delete(workerId);
    if (removed) {
      this.emitEvent('worker_removed', { workerId });
    }
    return removed;
  }

  borrowWorker(workerId: string, sourceInstance: string): LatamWorker | null {
    if (!this.config.borrowWorkersEnabled) {
      log.warn('Worker borrowing disabled for this instance');
      return null;
    }
    if (this.workers.size >= MAX_WORKERS) {
      log.warn('Worker limit reached, cannot borrow');
      return null;
    }

    const borrowed: LatamWorker = {
      id: workerId,
      name: `borrowed-${sourceInstance}-${workerId.slice(0, 8)}`,
      specialization: 'product-research',
      assignedCountries: [],
      taskCount: 0,
      successRate: 1.0,
      borrowed: true,
      borrowedFrom: sourceInstance,
      createdAt: new Date(),
    };

    this.workers.set(borrowed.id, borrowed);
    this.emitEvent('worker_borrowed', { workerId, sourceInstance });

    broadcast('meow:sovereign', {
      type: 'regional_worker_borrowed',
      instanceId: this.instanceId,
      workerId,
      sourceInstance,
    });

    log.info({ workerId, sourceInstance }, 'Worker borrowed from other instance');
    return borrowed;
  }

  returnBorrowedWorker(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker || !worker.borrowed) return false;

    this.workers.delete(workerId);
    this.emitEvent('worker_returned', { workerId, toInstance: worker.borrowedFrom });

    broadcast('meow:sovereign', {
      type: 'regional_worker_returned',
      instanceId: this.instanceId,
      workerId,
      toInstance: worker.borrowedFrom,
    });

    return true;
  }

  getAvailableWorkers(specialization?: WorkerSpecialization): LatamWorker[] {
    return Array.from(this.workers.values()).filter(w =>
      !specialization || w.specialization === specialization,
    );
  }

  // --- Molecule lifecycle ----------------------------------------------------

  registerMolecule(moleculeId: string, formulaName: RegionalFormulaName): void {
    if (this.status !== 'running') {
      log.warn({ moleculeId }, 'Cannot register molecule, instance not running');
      return;
    }
    if (this.activeMoleculeIds.size >= this.config.maxConcurrentMolecules) {
      log.warn({ moleculeId }, 'Max concurrent molecules reached');
      return;
    }

    this.activeMoleculeIds.add(moleculeId);
    this.formulaExecutions.set(
      formulaName,
      (this.formulaExecutions.get(formulaName) ?? 0) + 1,
    );

    this.emitEvent('molecule_registered', { moleculeId, formulaName });

    broadcast('meow:sovereign', {
      type: 'regional_molecule_registered',
      instanceId: this.instanceId,
      moleculeId,
      formulaName,
      activeMolecules: this.activeMoleculeIds.size,
    });
  }

  completeMolecule(moleculeId: string, success: boolean): void {
    this.activeMoleculeIds.delete(moleculeId);
    this.emitEvent('molecule_completed', { moleculeId, success });

    broadcast('meow:sovereign', {
      type: 'regional_molecule_completed',
      instanceId: this.instanceId,
      moleculeId,
      success,
      activeMolecules: this.activeMoleculeIds.size,
    });
  }

  // --- Country metrics -------------------------------------------------------

  updateCountryMetrics(country: LatamCountry, update: Partial<CountryMetrics>): void {
    const existing = this.countryMetrics.get(country);
    if (!existing) return;

    Object.assign(existing, update, { updatedAt: new Date() });
    this.countryMetrics.set(country, existing);

    this.emitEvent('country_metrics_updated', { country, ...update });

    broadcast('meow:sovereign', {
      type: 'regional_country_updated',
      instanceId: this.instanceId,
      country,
      gmvUsd: existing.gmvUsd,
      orders: existing.orders,
      fulfillmentRate: existing.fulfillmentRate,
    });
  }

  getCountryMetrics(country: LatamCountry): CountryMetrics | null {
    return this.countryMetrics.get(country) ?? null;
  }

  getAllCountryMetrics(): CountryMetrics[] {
    return Array.from(this.countryMetrics.values());
  }

  // --- Budget management -----------------------------------------------------

  recordSpend(amount: number, country?: LatamCountry, category?: 'ads' | 'fulfillment' | 'tools'): void {
    this.budget.spentUsd += amount;
    this.budget.utilizationPct = this.budget.monthlyLimitUsd > 0
      ? (this.budget.spentUsd / this.budget.monthlyLimitUsd) * 100
      : 0;

    if (country) {
      this.budget.perCountrySpent[country] =
        (this.budget.perCountrySpent[country] ?? 0) + amount;
    }

    if (category === 'ads') this.budget.adsSpendUsd += amount;
    else if (category === 'fulfillment') this.budget.fulfillmentSpendUsd += amount;
    else if (category === 'tools') this.budget.toolsSpendUsd += amount;

    this.budget.updatedAt = new Date();

    // Emit warning at thresholds
    if (this.budget.utilizationPct >= 90) {
      broadcast('meow:sovereign', {
        type: 'regional_budget_critical',
        instanceId: this.instanceId,
        utilizationPct: Math.round(this.budget.utilizationPct * 10) / 10,
        spentUsd: Math.round(this.budget.spentUsd * 100) / 100,
        limitUsd: this.budget.monthlyLimitUsd,
      });
      log.warn({ utilizationPct: this.budget.utilizationPct }, 'Regional budget critical');
    } else if (this.budget.utilizationPct >= 75) {
      broadcast('meow:sovereign', {
        type: 'regional_budget_warning',
        instanceId: this.instanceId,
        utilizationPct: Math.round(this.budget.utilizationPct * 10) / 10,
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
        reason: `Budget would exceed limit: $${projected.toFixed(2)} / $${this.budget.monthlyLimitUsd} (${projectedPct.toFixed(1)}%)`,
      };
    }

    return { allowed: true };
  }

  getBudget(): RegionalBudget {
    return { ...this.budget };
  }

  // --- AI-powered country analysis -------------------------------------------

  async analyzeCountryOpportunity(country: LatamCountry): Promise<{
    recommendation: string;
    score: number;
    factors: string[];
  }> {
    const metrics = this.countryMetrics.get(country);
    if (!metrics) {
      return { recommendation: 'No data available', score: 0, factors: [] };
    }

    const prompt = `Analyze this LATAM COD ecommerce country opportunity:
Country: ${country}
GMV: $${metrics.gmvUsd}
Orders: ${metrics.orders}
Avg order value: $${metrics.avgOrderValueUsd}
Fulfillment rate: ${(metrics.fulfillmentRate * 100).toFixed(1)}%
WA conversion: ${(metrics.waConversionRate * 100).toFixed(1)}%
COD collection rate: ${(metrics.codCollectionRate * 100).toFixed(1)}%
Return rate: ${(metrics.returnRate * 100).toFixed(1)}%
Active products: ${metrics.activeProducts}
Active suppliers: ${metrics.activeSuppliers}

Respond JSON: {"recommendation": "string", "score": 0-100, "factors": ["string"]}`;

    const raw = await callGemini(prompt);
    if (raw) {
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as {
            recommendation: string;
            score: number;
            factors: string[];
          };
          return {
            recommendation: parsed.recommendation ?? 'AI analysis complete',
            score: Math.max(0, Math.min(100, parsed.score ?? 50)),
            factors: Array.isArray(parsed.factors) ? parsed.factors : [],
          };
        }
      } catch {
        log.warn('Failed to parse AI country analysis');
      }
    }

    // Heuristic fallback
    const score = Math.round(
      (metrics.fulfillmentRate * 25) +
      (metrics.waConversionRate * 25) +
      (metrics.codCollectionRate * 25) +
      (Math.min(1, metrics.orders / 100) * 15) +
      (Math.min(1, metrics.activeProducts / 50) * 10),
    );

    const factors: string[] = [];
    if (metrics.fulfillmentRate < 0.7) factors.push('Low fulfillment rate needs improvement');
    if (metrics.waConversionRate > 0.1) factors.push('Good WhatsApp conversion');
    if (metrics.codCollectionRate < 0.8) factors.push('COD collection rate below target');
    if (metrics.returnRate > 0.1) factors.push('High return rate requires attention');
    if (metrics.activeSuppliers < 3) factors.push('Needs more supplier diversity');

    return {
      recommendation: score > 60 ? 'Country performing well, consider scaling' : 'Country needs optimization before scaling',
      score,
      factors,
    };
  }

  // --- Formulas --------------------------------------------------------------

  getAvailableFormulas(): typeof DEFAULT_FORMULAS {
    return { ...DEFAULT_FORMULAS };
  }

  getFormulaInfo(name: RegionalFormulaName): typeof DEFAULT_FORMULAS[RegionalFormulaName] | null {
    return DEFAULT_FORMULAS[name] ?? null;
  }

  // --- Config ----------------------------------------------------------------

  getConfig(): RegionalInstanceConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<RegionalInstanceConfig>): void {
    this.config = { ...this.config, ...updates };
    this.emitEvent('config_updated', { updates });
    log.info({ updates }, 'Regional config updated');
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): RegionalStats {
    const allMetrics = this.getAllCountryMetrics();
    const totalGmv = allMetrics.reduce((s, m) => s + m.gmvUsd, 0);
    const totalOrders = allMetrics.reduce((s, m) => s + m.orders, 0);
    const activeCountries = allMetrics.filter(m => m.orders > 0).length;
    const avgFulfillment = allMetrics.length > 0
      ? allMetrics.reduce((s, m) => s + m.fulfillmentRate, 0) / allMetrics.length
      : 0;
    const avgWa = allMetrics.length > 0
      ? allMetrics.reduce((s, m) => s + m.waConversionRate, 0) / allMetrics.length
      : 0;

    const borrowedCount = Array.from(this.workers.values()).filter(w => w.borrowed).length;

    return {
      status: this.status,
      totalWorkers: this.workers.size,
      borrowedWorkers: borrowedCount,
      activeMolecules: this.activeMoleculeIds.size,
      totalMoleculesRun: Array.from(this.formulaExecutions.values()).reduce((s, n) => s + n, 0),
      countriesActive: activeCountries,
      totalGmvUsd: Math.round(totalGmv * 100) / 100,
      totalOrders,
      avgFulfillmentRate: Math.round(avgFulfillment * 1000) / 1000,
      avgWaConversion: Math.round(avgWa * 1000) / 1000,
      budgetUtilizationPct: Math.round(this.budget.utilizationPct * 10) / 10,
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
        `SELECT country, gmv_usd, orders, avg_order_value_usd,
                fulfillment_rate, wa_conversion_rate, active_products,
                active_suppliers, return_rate, cod_collection_rate, updated_at
         FROM meow_instance_regional
         WHERE instance_id = $1
         ORDER BY updated_at DESC
         LIMIT 20`,
        [this.instanceId],
      );

      for (const r of rows as Array<Record<string, unknown>>) {
        const country = r.country as LatamCountry;
        if (LATAM_COUNTRIES.includes(country)) {
          this.countryMetrics.set(country, {
            country,
            gmvUsd: parseFloat(r.gmv_usd as string) || 0,
            orders: parseInt(r.orders as string) || 0,
            avgOrderValueUsd: parseFloat(r.avg_order_value_usd as string) || 0,
            fulfillmentRate: parseFloat(r.fulfillment_rate as string) || 0,
            waConversionRate: parseFloat(r.wa_conversion_rate as string) || 0,
            activeProducts: parseInt(r.active_products as string) || 0,
            activeSuppliers: parseInt(r.active_suppliers as string) || 0,
            returnRate: parseFloat(r.return_rate as string) || 0,
            codCollectionRate: parseFloat(r.cod_collection_rate as string) || 0,
            updatedAt: new Date(r.updated_at as string),
          });
        }
      }

      log.info({ instanceId: this.instanceId, loaded: rows.length }, 'Regional state loaded from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load Regional state from DB');
    }
  }

  async persistState(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    for (const [country, metrics] of this.countryMetrics) {
      try {
        await pool.query(
          `INSERT INTO meow_instance_regional
            (id, instance_id, country, gmv_usd, orders, avg_order_value_usd,
             fulfillment_rate, wa_conversion_rate, active_products, active_suppliers,
             return_rate, cod_collection_rate, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (instance_id, country) DO UPDATE SET
             gmv_usd = EXCLUDED.gmv_usd,
             orders = EXCLUDED.orders,
             avg_order_value_usd = EXCLUDED.avg_order_value_usd,
             fulfillment_rate = EXCLUDED.fulfillment_rate,
             wa_conversion_rate = EXCLUDED.wa_conversion_rate,
             active_products = EXCLUDED.active_products,
             active_suppliers = EXCLUDED.active_suppliers,
             return_rate = EXCLUDED.return_rate,
             cod_collection_rate = EXCLUDED.cod_collection_rate,
             updated_at = EXCLUDED.updated_at`,
          [
            uuidv4(),
            this.instanceId,
            country,
            metrics.gmvUsd,
            metrics.orders,
            metrics.avgOrderValueUsd,
            metrics.fulfillmentRate,
            metrics.waConversionRate,
            metrics.activeProducts,
            metrics.activeSuppliers,
            metrics.returnRate,
            metrics.codCollectionRate,
            metrics.updatedAt.toISOString(),
          ],
        );
      } catch (err) {
        log.warn({ err, country }, 'Failed to persist Regional country metrics');
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

let instance: GasTownRegional | null = null;

export function getGasTownRegional(
  config?: Partial<RegionalInstanceConfig>,
): GasTownRegional {
  if (!instance) {
    instance = new GasTownRegional(config);
    log.info('GasTownRegional singleton created');
  }
  return instance;
}

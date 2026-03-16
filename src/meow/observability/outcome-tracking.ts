/**
 * OUTCOME TRACKING — LP-038 (Stage 04 Wave 8)
 *
 * Links molecules to business results: ROAS, conversions, revenue,
 * products listed, engagement metrics, recovered customers.
 * Persists to Supabase `meow_outcomes` table.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type OutcomeType =
  | 'campaign_performance'    // ROAS, conversions, revenue, ad spend
  | 'product_discovery'       // products found, listed, first sale
  | 'content_engagement'      // views, likes, shares, comments
  | 'customer_recovery'       // recovered customers, recovered revenue
  | 'cost_optimization'       // cost saved, efficiency gained
  | 'revenue_attribution'     // direct revenue from molecule output
  | 'custom';

export interface Outcome {
  id: string;
  moleculeId: string;
  formulaName?: string;
  outcomeType: OutcomeType;
  metrics: Record<string, number>;
  description?: string;
  attributionConfidence: number;  // 0.0 - 1.0
  metadata?: Record<string, unknown>;
  recordedAt: Date;
}

export interface FormulaROI {
  formulaName: string;
  moleculeCount: number;
  totalCostUsd: number;
  totalRevenueUsd: number;
  roi: number;                  // (revenue - cost) / cost
  avgCostPerMolecule: number;
  avgRevenuePerMolecule: number;
}

export interface OutcomeSummary {
  since: Date;
  totalOutcomes: number;
  byType: Record<string, { count: number; topMetrics: Record<string, number> }>;
  totalRevenueAttributed: number;
  totalCostTracked: number;
  overallROI: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// OutcomeTracker
// ─────────────────────────────────────────────────────────────────────────────

export class OutcomeTracker {
  private outcomes: Outcome[] = [];
  private maxInMemory = 5_000;

  // ─── Record an outcome ───────────────────────────────────────────────

  async recordOutcome(
    moleculeId: string,
    outcomeType: OutcomeType,
    metrics: Record<string, number>,
    options?: {
      formulaName?: string;
      description?: string;
      attributionConfidence?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Outcome> {
    const outcome: Outcome = {
      id: uuidv4(),
      moleculeId,
      formulaName: options?.formulaName,
      outcomeType,
      metrics,
      description: options?.description,
      attributionConfidence: options?.attributionConfidence ?? 1.0,
      metadata: options?.metadata,
      recordedAt: new Date(),
    };

    // In-memory buffer
    this.outcomes.push(outcome);
    if (this.outcomes.length > this.maxInMemory) {
      this.outcomes = this.outcomes.slice(-this.maxInMemory);
    }

    // Persist
    await this.persistOutcome(outcome);

    // Broadcast
    broadcast('meow:outcomes', {
      type: 'outcome_recorded',
      outcome: {
        id: outcome.id,
        moleculeId: outcome.moleculeId,
        outcomeType: outcome.outcomeType,
        metrics: outcome.metrics,
        timestamp: outcome.recordedAt.toISOString(),
      },
    });

    return outcome;
  }

  // ─── Queries ─────────────────────────────────────────────────────────

  getMoleculeOutcomes(moleculeId: string): Outcome[] {
    return this.outcomes
      .filter(o => o.moleculeId === moleculeId)
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
  }

  getFormulaROI(formulaName: string): FormulaROI {
    const formulaOutcomes = this.outcomes.filter(o => o.formulaName === formulaName);

    const moleculeIds = new Set(formulaOutcomes.map(o => o.moleculeId));
    let totalRevenue = 0;
    let totalCost = 0;

    for (const outcome of formulaOutcomes) {
      totalRevenue += outcome.metrics.revenue ?? outcome.metrics.recovered_revenue ?? 0;
      totalCost += outcome.metrics.cost ?? outcome.metrics.ad_spend ?? 0;
    }

    const moleculeCount = moleculeIds.size;
    const roi = totalCost > 0 ? (totalRevenue - totalCost) / totalCost : 0;

    return {
      formulaName,
      moleculeCount,
      totalCostUsd: Math.round(totalCost * 100) / 100,
      totalRevenueUsd: Math.round(totalRevenue * 100) / 100,
      roi: Math.round(roi * 100) / 100,
      avgCostPerMolecule: moleculeCount > 0
        ? Math.round((totalCost / moleculeCount) * 100) / 100
        : 0,
      avgRevenuePerMolecule: moleculeCount > 0
        ? Math.round((totalRevenue / moleculeCount) * 100) / 100
        : 0,
    };
  }

  getTopPerformingFormulas(limit = 10): FormulaROI[] {
    const formulaNames = new Set(
      this.outcomes
        .filter(o => o.formulaName)
        .map(o => o.formulaName!),
    );

    const roiList: FormulaROI[] = [];
    for (const name of formulaNames) {
      roiList.push(this.getFormulaROI(name));
    }

    return roiList
      .sort((a, b) => b.roi - a.roi)
      .slice(0, limit);
  }

  getOutcomeSummary(since?: Date): OutcomeSummary {
    const cutoff = since ?? new Date(0);
    const filtered = this.outcomes.filter(o => o.recordedAt >= cutoff);

    const byType: Record<string, { count: number; topMetrics: Record<string, number> }> = {};
    let totalRevenue = 0;
    let totalCost = 0;

    for (const outcome of filtered) {
      const t = outcome.outcomeType;
      if (!byType[t]) {
        byType[t] = { count: 0, topMetrics: {} };
      }
      byType[t].count += 1;

      // Aggregate metrics per type
      for (const [key, val] of Object.entries(outcome.metrics)) {
        byType[t].topMetrics[key] = (byType[t].topMetrics[key] ?? 0) + val;
      }

      totalRevenue += outcome.metrics.revenue ?? outcome.metrics.recovered_revenue ?? 0;
      totalCost += outcome.metrics.cost ?? outcome.metrics.ad_spend ?? 0;
    }

    // Round all topMetrics
    for (const entry of Object.values(byType)) {
      for (const key of Object.keys(entry.topMetrics)) {
        entry.topMetrics[key] = Math.round(entry.topMetrics[key] * 100) / 100;
      }
    }

    const overallROI = totalCost > 0 ? (totalRevenue - totalCost) / totalCost : 0;

    return {
      since: cutoff,
      totalOutcomes: filtered.length,
      byType,
      totalRevenueAttributed: Math.round(totalRevenue * 100) / 100,
      totalCostTracked: Math.round(totalCost * 100) / 100,
      overallROI: Math.round(overallROI * 100) / 100,
    };
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  private async persistOutcome(outcome: Outcome): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_outcomes
          (id, molecule_id, formula_name, outcome_type, metrics,
           description, attribution_confidence, metadata, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          outcome.id,
          outcome.moleculeId,
          outcome.formulaName ?? null,
          outcome.outcomeType,
          JSON.stringify(outcome.metrics),
          outcome.description ?? null,
          outcome.attributionConfidence,
          outcome.metadata ? JSON.stringify(outcome.metadata) : null,
          outcome.recordedAt.toISOString(),
        ],
      );
    } catch (err) {
      console.error('[OutcomeTracker] Failed to persist outcome:', err);
    }
  }

  /** Load historical outcomes from DB */
  async loadFromDb(sinceDays = 30): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const since = new Date();
      since.setDate(since.getDate() - sinceDays);

      const { rows } = await pool.query(
        `SELECT id, molecule_id, formula_name, outcome_type, metrics,
                description, attribution_confidence, metadata, recorded_at
         FROM meow_outcomes
         WHERE recorded_at >= $1
         ORDER BY recorded_at DESC
         LIMIT $2`,
        [since.toISOString(), this.maxInMemory],
      );

      this.outcomes = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        moleculeId: r.molecule_id as string,
        formulaName: (r.formula_name as string) ?? undefined,
        outcomeType: r.outcome_type as OutcomeType,
        metrics: (typeof r.metrics === 'string' ? JSON.parse(r.metrics) : r.metrics) as Record<string, number>,
        description: (r.description as string) ?? undefined,
        attributionConfidence: parseFloat(r.attribution_confidence as string),
        metadata: r.metadata as Record<string, unknown> | undefined,
        recordedAt: new Date(r.recorded_at as string),
      }));

      console.info(`[OutcomeTracker] Loaded ${this.outcomes.length} outcomes from DB`);
    } catch (err) {
      console.error('[OutcomeTracker] Failed to load from DB:', err);
    }
  }

  getEntryCount(): number {
    return this.outcomes.length;
  }
}

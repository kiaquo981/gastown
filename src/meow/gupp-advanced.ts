/**
 * GUPP Advanced — EP-064→066
 * Backpressure, Priority Queuing, Metrics
 */

import { gupp } from './workers/gupp';

/* ---------- Types ---------- */
interface BackpressureConfig {
  maxPendingHooks: number;
  warningThreshold: number;
  backoffMs: number;
  maxBackoffMs: number;
}

interface GUPPMetrics {
  totalPlaced: number;
  totalCompleted: number;
  totalFailed: number;
  totalExpired: number;
  avgClaimLatencyMs: number;
  avgExecutionMs: number;
  hooksByPriority: Record<number, number>;
  backpressureEvents: number;
  lastMetricReset: string;
}

interface PriorityBucket {
  priority: number;
  label: string;
  maxConcurrent: number;
  currentActive: number;
}

/* ---------- GUPP Advanced ---------- */
class GUPPAdvanced {
  private config: BackpressureConfig = {
    maxPendingHooks: 100,
    warningThreshold: 80,
    backoffMs: 1000,
    maxBackoffMs: 30000,
  };

  private metrics: GUPPMetrics = {
    totalPlaced: 0,
    totalCompleted: 0,
    totalFailed: 0,
    totalExpired: 0,
    avgClaimLatencyMs: 0,
    avgExecutionMs: 0,
    hooksByPriority: {},
    backpressureEvents: 0,
    lastMetricReset: new Date().toISOString(),
  };

  private claimTimestamps = new Map<string, number>(); // hookId → claimTime
  private executionTimes: number[] = [];
  private claimLatencies: number[] = [];

  private priorityBuckets: PriorityBucket[] = [
    { priority: 0, label: 'critical', maxConcurrent: 10, currentActive: 0 },
    { priority: 1, label: 'high', maxConcurrent: 8, currentActive: 0 },
    { priority: 2, label: 'normal', maxConcurrent: 5, currentActive: 0 },
    { priority: 3, label: 'low', maxConcurrent: 3, currentActive: 0 },
  ];

  // ─── EP-064: Backpressure ────────────────────────────────────────────────

  setBackpressureConfig(config: Partial<BackpressureConfig>): void {
    Object.assign(this.config, config);
    console.info(`[GUPP-ADV] Backpressure config updated: max=${this.config.maxPendingHooks} warn=${this.config.warningThreshold}`);
  }

  getBackpressureConfig(): BackpressureConfig {
    return { ...this.config };
  }

  checkBackpressure(): { status: 'ok' | 'warning' | 'critical'; pending: number; capacity: number; backoffMs: number } {
    const stats = gupp.stats();
    const pending = stats.pendingHooks ?? 0;
    const pct = (pending / this.config.maxPendingHooks) * 100;

    if (pct >= 100) {
      this.metrics.backpressureEvents++;
      return { status: 'critical', pending, capacity: this.config.maxPendingHooks, backoffMs: this.config.maxBackoffMs };
    }
    if (pct >= this.config.warningThreshold) {
      const backoff = Math.min(this.config.backoffMs * Math.pow(2, Math.floor(pct / 10)), this.config.maxBackoffMs);
      return { status: 'warning', pending, capacity: this.config.maxPendingHooks, backoffMs: backoff };
    }
    return { status: 'ok', pending, capacity: this.config.maxPendingHooks, backoffMs: 0 };
  }

  shouldAcceptHook(): boolean {
    const bp = this.checkBackpressure();
    if (bp.status === 'critical') {
      console.warn(`[GUPP-ADV] Backpressure CRITICAL — rejecting hook (${bp.pending}/${bp.capacity})`);
      return false;
    }
    return true;
  }

  // ─── EP-065: Priority Queuing ────────────────────────────────────────────

  setPriorityBucket(priority: number, config: Partial<PriorityBucket>): void {
    const bucket = this.priorityBuckets.find(b => b.priority === priority);
    if (bucket) Object.assign(bucket, config);
    else this.priorityBuckets.push({ priority, label: `p${priority}`, maxConcurrent: 5, currentActive: 0, ...config });
    this.priorityBuckets.sort((a, b) => a.priority - b.priority);
  }

  getPriorityBuckets(): PriorityBucket[] {
    return this.priorityBuckets.map(b => ({ ...b }));
  }

  canClaimAtPriority(priority: number): boolean {
    const bucket = this.priorityBuckets.find(b => b.priority === priority);
    if (!bucket) return true;
    return bucket.currentActive < bucket.maxConcurrent;
  }

  trackClaim(hookId: string, priority: number): void {
    this.claimTimestamps.set(hookId, Date.now());
    this.metrics.hooksByPriority[priority] = (this.metrics.hooksByPriority[priority] || 0) + 1;
    const bucket = this.priorityBuckets.find(b => b.priority === priority);
    if (bucket) bucket.currentActive++;
  }

  trackComplete(hookId: string, priority: number, durationMs: number): void {
    const claimTime = this.claimTimestamps.get(hookId);
    if (claimTime) {
      this.claimLatencies.push(Date.now() - claimTime);
      this.claimTimestamps.delete(hookId);
    }
    this.executionTimes.push(durationMs);
    this.metrics.totalCompleted++;
    const bucket = this.priorityBuckets.find(b => b.priority === priority);
    if (bucket && bucket.currentActive > 0) bucket.currentActive--;

    // Keep arrays bounded
    if (this.executionTimes.length > 1000) this.executionTimes = this.executionTimes.slice(-500);
    if (this.claimLatencies.length > 1000) this.claimLatencies = this.claimLatencies.slice(-500);
  }

  trackFailed(hookId: string, priority: number): void {
    this.metrics.totalFailed++;
    this.claimTimestamps.delete(hookId);
    const bucket = this.priorityBuckets.find(b => b.priority === priority);
    if (bucket && bucket.currentActive > 0) bucket.currentActive--;
  }

  trackPlaced(): void { this.metrics.totalPlaced++; }
  trackExpired(): void { this.metrics.totalExpired++; }

  // ─── EP-066: Metrics ─────────────────────────────────────────────────────

  getMetrics(): GUPPMetrics {
    const avgExec = this.executionTimes.length > 0
      ? Math.round(this.executionTimes.reduce((s, t) => s + t, 0) / this.executionTimes.length)
      : 0;
    const avgClaim = this.claimLatencies.length > 0
      ? Math.round(this.claimLatencies.reduce((s, t) => s + t, 0) / this.claimLatencies.length)
      : 0;

    return {
      ...this.metrics,
      avgClaimLatencyMs: avgClaim,
      avgExecutionMs: avgExec,
    };
  }

  resetMetrics(): void {
    this.metrics = {
      totalPlaced: 0, totalCompleted: 0, totalFailed: 0, totalExpired: 0,
      avgClaimLatencyMs: 0, avgExecutionMs: 0,
      hooksByPriority: {}, backpressureEvents: 0,
      lastMetricReset: new Date().toISOString(),
    };
    this.executionTimes = [];
    this.claimLatencies = [];
    console.info('[GUPP-ADV] Metrics reset');
  }

  stats() {
    const bp = this.checkBackpressure();
    return {
      backpressure: bp,
      metrics: this.getMetrics(),
      buckets: this.getPriorityBuckets(),
    };
  }
}

export const guppAdvanced = new GUPPAdvanced();

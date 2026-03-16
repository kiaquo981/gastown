/**
 * Stage 04 — Living Pipeline Initialization
 *
 * Boots all Stage 04 services:
 * - Real skill implementations (LP-013–020)
 * - GUPP triggers: cron, threshold, event chain (LP-021–024)
 * - Mail bridges: WhatsApp, Email, SSE, Slack (LP-025–028)
 * - Bead sync: Supabase, ProjectQueue, GitHub, MegaBrain (LP-029–032)
 * - Observability enhancements (LP-036–040)
 *
 * Called from index.ts after MEOW workers are online.
 */

export async function initStage04(): Promise<void> {
  const t0 = Date.now();
  const results: string[] = [];

  // ── 1. Register Stage 04 Skills (LP-013–020) ──────────────────
  try {
    const { registerAllStage04Skills } = await import('./skills');
    const count = registerAllStage04Skills();
    results.push(`Skills: ${count} registered`);
  } catch (err) {
    console.warn('[Stage04] Skills registration failed:', (err as Error).message);
    results.push('Skills: FAILED');
  }

  // ── 2. Start GUPP Triggers (LP-021–024) ───────────────────────
  try {
    const { initAllTriggers } = await import('./triggers');
    initAllTriggers();
    results.push('Triggers: cron+threshold+chains started');
  } catch (err) {
    console.warn('[Stage04] Triggers init failed:', (err as Error).message);
    results.push('Triggers: FAILED');
  }

  // ── 3. Initialize Mail Bridges (LP-025–028) ───────────────────
  try {
    const { getMailBridgeOrchestrator } = await import('./bridges');
    const bridgeOrch = getMailBridgeOrchestrator();
    const status = bridgeOrch.getStatus();
    const active = Object.entries(status).filter(([, v]) => v === true).map(([k]) => k);
    results.push(`Mail Bridges: ${active.length > 0 ? active.join(', ') : 'SSE only'}`);
  } catch (err) {
    console.warn('[Stage04] Mail bridges init failed:', (err as Error).message);
    results.push('Mail Bridges: FAILED');
  }

  // ── 4. Start Bead Sync (LP-029–032) ───────────────────────────
  try {
    const { getBeadSyncOrchestrator } = await import('./sync');
    const syncOrch = getBeadSyncOrchestrator();
    syncOrch.start();
    results.push('Bead Sync: started');
  } catch (err) {
    console.warn('[Stage04] Bead sync init failed:', (err as Error).message);
    results.push('Bead Sync: FAILED');
  }

  // ── 5. Initialize Observability Enhancements (LP-036–040) ─────
  try {
    const { initObservability } = await import('./observability/index');
    await initObservability();
    results.push('Observability: enhanced');
  } catch (err) {
    console.warn('[Stage04] Observability init failed:', (err as Error).message);
    results.push('Observability: FAILED');
  }

  const elapsed = Date.now() - t0;
  console.info(`[MEOW] Stage 04 Living Pipeline initialized (${elapsed}ms) — ${results.join(' | ')}`);
}

/**
 * Stage 04 graceful shutdown — stop all background loops.
 */
export function shutdownStage04(): void {
  try {
    const { stopAllTriggers } = require('./triggers');
    stopAllTriggers();
  } catch { /* not loaded */ }

  try {
    const { getBeadSyncOrchestrator } = require('./sync');
    getBeadSyncOrchestrator().stop();
  } catch { /* not loaded */ }

  console.info('[MEOW] Stage 04 services stopped');
}

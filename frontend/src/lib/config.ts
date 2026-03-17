/**
 * Gas Town Frontend Configuration
 *
 * ORCHESTRATOR_URL points to the Gas Town backend server.
 * Set NEXT_PUBLIC_GASTOWN_URL in .env.local to override.
 */

export const ORCHESTRATOR_URL =
  process.env.NEXT_PUBLIC_GASTOWN_URL || 'https://gastown-production.up.railway.app';

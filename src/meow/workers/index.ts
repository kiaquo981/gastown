/**
 * Worker Roles — Gas Town hierarchy
 *
 * Mayor → orchestrates, never codes
 * Polecat → ephemeral workers in isolated worktrees
 * Witness → supervises polecats, nudges/escalates
 * Deacon → system health daemon with Dogs
 * Boot → watchdog for Deacon (future)
 * Crew → long-lived named agents (persistent identity)
 * Refinery → merge queue manager (future)
 * Overseer → human operator
 */

export { Mayor, mayor } from './mayor';
export { PolecatManager, polecatManager, type PolecatInstance, type PolecatManagerConfig } from './polecat';
export { Witness, type WitnessConfig } from './witness';
export { Deacon, deacon, type DeaconConfig } from './deacon';

/**
 * In-memory stores for SSE clients, activity log, and tasks.
 * Shared between sse.ts and the server entry point.
 */

import { EventEmitter } from 'events';
import type { SSEClient, ActivityLog, TaskEntry } from './types';

/** Connected SSE clients — mutated in-place by sse.ts broadcast/heartbeat */
export const sseClients: SSEClient[] = [];

/** Recent activity log — capped at 100 entries by sse.ts addActivity */
export const activityLog: ActivityLog[] = [];

/** Active task registry — keyed by task ID */
export const tasks = new Map<string, TaskEntry>();

/** Task event bus — emits 'update' when task status changes */
export const taskBus = new EventEmitter();

/** Agent registry — keyed by agent ID (for crew-agent-bridge) */
export const agents = new Map<string, { id: string; name: string; status: string; config: Record<string, unknown> }>();

/**
 * SSE broadcasting utilities
 */

import { v4 as uuidv4 } from 'uuid';
import type { ActivityLog } from './types';
import { sseClients, activityLog, tasks } from './stores';

export function broadcast(event: string, data: unknown): void {
  let jsonData: string;
  try {
    jsonData = JSON.stringify(data);
  } catch (e) {
    console.error(`[SSE] Failed to serialize ${event}:`, e);
    return;
  }

  const message = `event: ${event}\ndata: ${jsonData}\n\n`;
  const alive: typeof sseClients = [];

  for (const client of sseClients) {
    try {
      client.response.write(message);
      alive.push(client);
    } catch {
      console.info(`[SSE] Removing dead client: ${client.id}`);
    }
  }

  sseClients.length = 0;
  sseClients.push(...alive);
}

export function computeSuccessRate(): number {
  const allTasks = Array.from(tasks.values());
  const done = allTasks.filter(t => t.status === 'completed' || t.status === 'failed');
  if (done.length === 0) return 100;
  const completed = done.filter(t => t.status === 'completed').length;
  return Math.round((completed / done.length) * 1000) / 10;
}

const broadcastTimers: Record<string, NodeJS.Timeout> = {};
const broadcastPending: Record<string, unknown> = {};

export function broadcastThrottled(event: string, data: unknown): void {
  broadcastPending[event] = data;
  if (!broadcastTimers[event]) {
    broadcastTimers[event] = setTimeout(() => {
      broadcast(event, broadcastPending[event]);
      delete broadcastTimers[event];
      delete broadcastPending[event];
    }, 1000);
  }
}

export function addActivity(activity: Omit<ActivityLog, 'id' | 'timestamp'>): void {
  const log: ActivityLog = {
    ...activity,
    id: uuidv4(),
    timestamp: new Date(),
  };
  activityLog.unshift(log);
  if (activityLog.length > 100) activityLog.splice(100);
  broadcast('activity', log);
}

/** Alias for services/connectors that use the { type, data } payload shape */
export function broadcastSSE(payload: { type: string; data: unknown }): void {
  broadcast(payload.type, payload.data);
}

// SSE heartbeat — keeps Railway load balancer connections alive
setInterval(() => {
  const alive: typeof sseClients = [];
  for (const client of sseClients) {
    try {
      client.response.write('event: ping\ndata: {}\n\n');
      alive.push(client);
    } catch {
      console.info(`[SSE] Heartbeat: removing dead client`);
    }
  }
  sseClients.length = 0;
  sseClients.push(...alive);
}, 30_000);

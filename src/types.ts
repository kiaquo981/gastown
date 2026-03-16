/**
 * Shared types for the Gas Town server layer (SSE, stores, middleware).
 * MEOW-specific types are in meow/types.ts.
 */

import type { Response } from 'express';

export interface SSEClient {
  id: string;
  response: Response;
  connectedAt: Date;
}

export interface ActivityLog {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  action: string;
  details: string;
  timestamp: Date;
  agentId?: string;
  agentName?: string;
}

export interface TaskEntry {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  title: string;
  createdAt: Date;
  updatedAt: Date;
  result?: unknown;
  error?: string;
}

/** Alias used by some route files */
export type Task = TaskEntry;

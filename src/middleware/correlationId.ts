/**
 * Correlation ID middleware — attaches a unique request ID to each request.
 * Used by the logger to trace requests across service calls.
 */

import { v4 as uuidv4 } from 'uuid';
import { AsyncLocalStorage } from 'async_hooks';
import type { Request, Response, NextFunction } from 'express';

const storage = new AsyncLocalStorage<string>();

/** Express middleware: injects correlation ID into async context */
export function correlationIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string) || uuidv4();
  storage.run(id, () => next());
}

/** Get the current request's correlation ID (or undefined outside request context) */
export function getCorrelationId(): string | undefined {
  return storage.getStore();
}

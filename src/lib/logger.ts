/**
 * Structured logger — US-005
 * Pino-based logger with correlation ID injection and child logger factory.
 */

import pino from 'pino';
import { getCorrelationId } from '../middleware/correlationId';

const isDev = process.env.NODE_ENV !== 'production';
const level = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');

export const logger = pino({
  level,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
  mixin() {
    const requestId = getCorrelationId();
    return requestId ? { requestId } : {};
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

/** Create a child logger scoped to a specific module */
export function createLogger(module: string): pino.Logger {
  return logger.child({ module });
}

export default logger;

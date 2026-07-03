import { redact } from './security.js';

/**
 * Minimal structured logger. Every message is passed through redaction so a
 * secret can never reach stdout/stderr, even if accidentally interpolated.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function activeLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (raw in LEVEL_ORDER) return raw as LogLevel;
  return 'info';
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;
  const safeMessage = redact(message);
  let metaStr = '';
  if (meta && Object.keys(meta).length > 0) {
    try {
      metaStr = ' ' + redact(JSON.stringify(meta));
    } catch {
      metaStr = ' [unserializable meta]';
    }
  }
  const line = `[${level.toUpperCase()}] ${safeMessage}${metaStr}`;
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit('error', m, meta),
};

/** A named stage banner for readable run logs. */
export function stage(name: string): void {
  log.info(`── stage: ${name} ──`);
}

import crypto from 'node:crypto';
import { R2, getPrivateJson, putPrivateJson, deletePrivate } from './r2.js';
import { log } from './logger.js';

/**
 * Distributed workflow lock backed by the private R2 bucket. Ensures only one
 * workflow (manual or scheduled) runs at a time. Supports stale-lock recovery.
 */

export const LOCK_KEY = 'locks/workflow.json';
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface LockRecord {
  runId: string;
  acquiredAt: number;
  expiresAt: number;
  ideaId: string | null;
  stage: string;
}

export interface LockHandle {
  runId: string;
  record: LockRecord;
}

/** Now in epoch ms. Isolated so tests can stay deterministic if needed. */
function now(): number {
  return Date.now();
}

export function newRunId(): string {
  return `run_${crypto.randomUUID()}`;
}

/**
 * Attempt to acquire the workflow lock. Returns a handle on success, or null
 * when another live (non-expired) lock is held by a different run.
 */
export async function acquireLock(
  r2: R2,
  opts: { runId?: string; ttlMs?: number; ideaId?: string | null; stage?: string } = {},
): Promise<LockHandle | null> {
  const runId = opts.runId ?? newRunId();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const existing = await getPrivateJson<LockRecord>(r2, LOCK_KEY);

  if (existing && existing.expiresAt > now() && existing.runId !== runId) {
    log.warn('workflow lock held by another run', {
      holder: existing.runId,
      stage: existing.stage,
      msRemaining: existing.expiresAt - now(),
    });
    return null;
  }

  if (existing && existing.expiresAt <= now()) {
    log.warn('recovering stale workflow lock', { staleRunId: existing.runId });
  }

  const record: LockRecord = {
    runId,
    acquiredAt: now(),
    expiresAt: now() + ttlMs,
    ideaId: opts.ideaId ?? null,
    stage: opts.stage ?? 'init',
  };
  await putPrivateJson(r2, LOCK_KEY, record);

  // Read-back confirm we own it (guards against a race where two runs write).
  const confirm = await getPrivateJson<LockRecord>(r2, LOCK_KEY);
  if (!confirm || confirm.runId !== runId) {
    log.warn('lost lock race after write', { runId, owner: confirm?.runId });
    return null;
  }
  log.info('acquired workflow lock', { runId });
  return { runId, record };
}

/** Update the lock's current stage / idea and extend its expiry. */
export async function heartbeatLock(
  r2: R2,
  handle: LockHandle,
  update: { stage?: string; ideaId?: string | null; ttlMs?: number },
): Promise<void> {
  const current = await getPrivateJson<LockRecord>(r2, LOCK_KEY);
  if (!current || current.runId !== handle.runId) {
    log.warn('cannot heartbeat: lock no longer owned', { runId: handle.runId });
    return;
  }
  const ttlMs = update.ttlMs ?? DEFAULT_TTL_MS;
  const record: LockRecord = {
    ...current,
    stage: update.stage ?? current.stage,
    ideaId: update.ideaId ?? current.ideaId,
    expiresAt: now() + ttlMs,
  };
  handle.record = record;
  await putPrivateJson(r2, LOCK_KEY, record);
}

/** Release the lock only if we still own it. Safe to call in finally. */
export async function releaseLock(r2: R2, handle: LockHandle | null): Promise<boolean> {
  if (!handle) return false;
  try {
    const current = await getPrivateJson<LockRecord>(r2, LOCK_KEY);
    if (current && current.runId !== handle.runId) {
      log.warn('not releasing lock owned by another run', { owner: current.runId });
      return false;
    }
    await deletePrivate(r2, LOCK_KEY);
    log.info('released workflow lock', { runId: handle.runId });
    return true;
  } catch (err) {
    log.warn('lock release failed', { runId: handle.runId });
    void err;
    return false;
  }
}

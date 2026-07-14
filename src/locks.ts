import crypto from 'node:crypto';
import {
  R2,
  getPrivateJson,
  getPrivateJsonWithEtag,
  putPrivateJson,
  deletePrivate,
  isPreconditionFailed,
} from './r2.js';
import { log } from './logger.js';

/**
 * Distributed workflow lock backed by the private R2 bucket. Ensures only one
 * workflow (manual or scheduled) runs at a time. Supports stale-lock recovery.
 *
 * Writes are CONDITIONAL (If-None-Match on create, If-Match on replace and
 * heartbeat) so two runs racing through the read-check-write sequence cannot
 * both come away believing they hold the lock; the loser's put is rejected
 * with a 412 by R2 itself.
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
  const existing = await getPrivateJsonWithEtag<LockRecord>(r2, LOCK_KEY);

  if (existing && existing.value.expiresAt > now() && existing.value.runId !== runId) {
    log.warn('workflow lock held by another run', {
      holder: existing.value.runId,
      stage: existing.value.stage,
      msRemaining: existing.value.expiresAt - now(),
    });
    return null;
  }

  if (existing && existing.value.expiresAt <= now()) {
    log.warn('recovering stale workflow lock', { staleRunId: existing.value.runId });
  }

  const record: LockRecord = {
    runId,
    acquiredAt: now(),
    expiresAt: now() + ttlMs,
    ideaId: opts.ideaId ?? null,
    stage: opts.stage ?? 'init',
  };
  // Atomic write: create-if-absent, or replace exactly the record we examined
  // (stale or our own re-entrant lock). A concurrent writer flips the ETag and
  // this put is rejected — the loser backs off instead of clobbering.
  try {
    await putPrivateJson(
      r2,
      LOCK_KEY,
      record,
      existing?.etag ? { ifMatch: existing.etag } : { ifNoneMatch: '*' },
    );
  } catch (err) {
    if (isPreconditionFailed(err)) {
      log.warn('lost lock race to a concurrent run', { runId });
      return null;
    }
    throw err;
  }

  // Belt-and-suspenders read-back (also covers stores without ETag support).
  const confirm = await getPrivateJson<LockRecord>(r2, LOCK_KEY);
  if (!confirm || confirm.runId !== runId) {
    log.warn('lost lock race after write', { runId, owner: confirm?.runId });
    return null;
  }
  log.info('acquired workflow lock', { runId });
  return { runId, record };
}

/**
 * Update the lock's current stage / idea and extend its expiry. Returns
 * whether this run STILL OWNS the lock — `false` means another run took it
 * (stale recovery) and the caller must abort rather than keep working.
 */
export async function heartbeatLock(
  r2: R2,
  handle: LockHandle,
  update: { stage?: string; ideaId?: string | null; ttlMs?: number },
): Promise<boolean> {
  const current = await getPrivateJsonWithEtag<LockRecord>(r2, LOCK_KEY);
  if (!current || current.value.runId !== handle.runId) {
    log.warn('cannot heartbeat: lock no longer owned', { runId: handle.runId });
    return false;
  }
  const ttlMs = update.ttlMs ?? DEFAULT_TTL_MS;
  const record: LockRecord = {
    ...current.value,
    stage: update.stage ?? current.value.stage,
    ideaId: update.ideaId ?? current.value.ideaId,
    expiresAt: now() + ttlMs,
  };
  try {
    await putPrivateJson(
      r2,
      LOCK_KEY,
      record,
      current.etag ? { ifMatch: current.etag } : undefined,
    );
  } catch (err) {
    if (isPreconditionFailed(err)) {
      log.warn('heartbeat lost race: lock rewritten by another run', { runId: handle.runId });
      return false;
    }
    throw err;
  }
  handle.record = record;
  return true;
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

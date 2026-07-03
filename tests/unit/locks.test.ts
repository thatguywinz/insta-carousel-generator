import { describe, it, expect } from 'vitest';
import { acquireLock, releaseLock, heartbeatLock, LOCK_KEY } from '../../src/locks.js';
import { getPrivateJson } from '../../src/r2.js';
import { createFakeR2 } from '../fixtures/fake-r2.js';

describe('distributed lock', () => {
  it('acquires when free and releases cleanly', async () => {
    const r2 = createFakeR2();
    const handle = await acquireLock(r2, { runId: 'run-1' });
    expect(handle).not.toBeNull();
    const released = await releaseLock(r2, handle);
    expect(released).toBe(true);
    expect(await getPrivateJson(r2, LOCK_KEY)).toBeNull();
  });

  it('refuses a second concurrent run', async () => {
    const r2 = createFakeR2();
    const first = await acquireLock(r2, { runId: 'run-1', ttlMs: 60000 });
    expect(first).not.toBeNull();
    const second = await acquireLock(r2, { runId: 'run-2', ttlMs: 60000 });
    expect(second).toBeNull();
  });

  it('recovers a stale (expired) lock', async () => {
    const r2 = createFakeR2();
    // Write an expired lock directly.
    await r2.client.send({
      constructor: { name: 'PutObjectCommand' },
      input: {
        Bucket: r2.privateBucket,
        Key: LOCK_KEY,
        Body: JSON.stringify({
          runId: 'old',
          acquiredAt: 0,
          expiresAt: 1,
          ideaId: null,
          stage: 'x',
        }),
      },
    } as never);
    const handle = await acquireLock(r2, { runId: 'run-2' });
    expect(handle).not.toBeNull();
    expect(handle?.runId).toBe('run-2');
  });

  it('does not release a lock owned by another run', async () => {
    const r2 = createFakeR2();
    await acquireLock(r2, { runId: 'run-1', ttlMs: 60000 });
    const released = await releaseLock(r2, {
      runId: 'run-2',
      record: { runId: 'run-2', acquiredAt: 0, expiresAt: 0, ideaId: null, stage: 'x' },
    });
    expect(released).toBe(false);
  });

  it('heartbeat updates stage and extends expiry', async () => {
    const r2 = createFakeR2();
    const handle = await acquireLock(r2, { runId: 'run-1', ttlMs: 1000 });
    expect(handle).not.toBeNull();
    await heartbeatLock(r2, handle!, { stage: 'publish', ttlMs: 60000 });
    const rec = await getPrivateJson<{ stage: string }>(r2, LOCK_KEY);
    expect(rec?.stage).toBe('publish');
  });
});

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { log } from './logger.js';

/**
 * DOM globals referenced inside `page.evaluate` callbacks. Those bodies execute
 * in the browser context, but the Node typechecker (no DOM lib in this project)
 * still parses them, so we declare the minimal shape here. `declare` emits no
 * runtime code.
 */
declare const document: {
  getAnimations(): Array<{ pause(): void; currentTime: number | null }>;
};
declare const requestAnimationFrame: (cb: () => void) => number;

/**
 * Deterministic motion capture: an animated slide is captured frame-by-frame by
 * pausing the page's Web-Animations timeline and stepping each animation's
 * `currentTime`, then encoding the frames into an Instagram-compatible H.264 MP4.
 *
 * This is frame-perfect and reproducible — unlike real-time screen recording —
 * which matches the rest of the render pipeline's determinism.
 */

/** Capture cadence + output length. 60 captured frames (2s @30fps) form one */
/** seamless loop; ffmpeg loops it up to OUTPUT_SECONDS to clear IG's 3s floor. */
export const MOTION_FPS = 30;
export const MOTION_LOOP_SECONDS = 2;
export const MOTION_OUTPUT_SECONDS = 5;
export const MOTION_FRAME_COUNT = MOTION_FPS * MOTION_LOOP_SECONDS;

const require = createRequire(import.meta.url);

/**
 * Resolve a full ffmpeg with libx264 + aac. Deliberately does NOT use Playwright's
 * bundled ffmpeg (it is built `--disable-everything` with only VP8/WebM and cannot
 * produce H.264 MP4). Order: FFMPEG_PATH env → @ffmpeg-installer binary (ships a
 * full static build inside the npm tarball) → `ffmpeg` on PATH.
 */
export function resolveFfmpeg(): string {
  const env = process.env.FFMPEG_PATH;
  if (env && existsSync(env)) return env;
  try {
    const installer = require('@ffmpeg-installer/ffmpeg') as { path?: string };
    if (installer.path && existsSync(installer.path)) return installer.path;
  } catch (err) {
    log.warn('ffmpeg installer not resolvable, falling back to PATH', { err: String(err) });
  }
  return 'ffmpeg';
}

/** Run ffmpeg, resolving on exit 0 and rejecting with tail stderr otherwise. */
function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}

/**
 * Confirm the resolved ffmpeg can actually encode H.264 (libx264). Used by the
 * healthcheck so a webm-only binary fails loudly instead of at render time.
 */
export async function ffmpegHasH264(bin = resolveFfmpeg()): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.on('error', () => resolve(false));
    proc.on('close', () => resolve(/\blibx264\b/.test(out)));
  });
}

/** Pause every running animation and seek to t=0 (the settled poster frame). */
export async function pauseAndReset(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (const a of document.getAnimations()) {
      try {
        a.pause();
        a.currentTime = 0;
      } catch {
        /* some animations reject seeking; ignore */
      }
    }
    // Force a paint so the frame reflects the reset state.
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
}

/**
 * Capture MOTION_FRAME_COUNT PNG frames by stepping the (already-paused) timeline.
 * Frame 0 is the settled t=0 composition and doubles as the poster/thumbnail.
 */
export async function captureFrames(
  page: Page,
  clip: { width: number; height: number },
): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  const step = 1000 / MOTION_FPS;
  for (let f = 0; f < MOTION_FRAME_COUNT; f++) {
    const t = f * step;
    await page.evaluate(async (time) => {
      for (const a of document.getAnimations()) {
        try {
          a.currentTime = time;
        } catch {
          /* ignore un-seekable animations */
        }
      }
      // Double rAF: guarantee the seeked frame is painted before the screenshot.
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    }, t);
    const png = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: clip.width, height: clip.height },
    });
    frames.push(Buffer.from(png));
  }
  return frames;
}

/**
 * Encode PNG frames into an Instagram-ready MP4: H.264 High / yuv420p, silent AAC
 * track (audio-less carousel videos are a known flaky area), moov atom first
 * (+faststart). The 2s frame loop is repeated to OUTPUT_SECONDS so the container
 * clears IG's 3-second minimum — the loop is in the invocation, not just intent.
 */
export async function encodeMp4(frames: Buffer[], ffmpegPath = resolveFfmpeg()): Promise<Buffer> {
  if (frames.length === 0) throw new Error('encodeMp4: no frames to encode');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'carousel-motion-'));
  try {
    await Promise.all(
      frames.map((buf, i) =>
        writeFile(path.join(dir, `frame-${String(i).padStart(4, '0')}.png`), buf),
      ),
    );
    const out = path.join(dir, 'out.mp4');
    // plays needed to reach OUTPUT_SECONDS; -stream_loop counts *additional* plays.
    const plays = Math.ceil(MOTION_OUTPUT_SECONDS / MOTION_LOOP_SECONDS);
    const args = [
      '-y',
      '-stream_loop',
      String(plays - 1),
      '-framerate',
      String(MOTION_FPS),
      '-i',
      path.join(dir, 'frame-%04d.png'),
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=stereo',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'high',
      '-crf',
      '20',
      '-preset',
      'medium',
      '-r',
      String(MOTION_FPS),
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
      '-t',
      String(MOTION_OUTPUT_SECONDS),
      '-movflags',
      '+faststart',
      out,
    ];
    await runFfmpeg(ffmpegPath, args);
    const mp4 = await readFile(out);
    log.info('encoded motion slide', { bytes: mp4.length, frames: frames.length });
    return mp4;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Lightweight structural sanity check for an encoded MP4 without ffprobe (the
 * installer ships ffmpeg only). Confirms it is a real MP4 (`ftyp` box) within
 * Instagram's size envelope. Deep spec validation happens in `verify:motion`
 * against the live API.
 */
export function inspectMp4(buf: Buffer): { ok: boolean; reason?: string; bytes: number } {
  const bytes = buf.length;
  if (bytes < 3000) return { ok: false, reason: 'mp4 too small (likely empty)', bytes };
  if (bytes > 100 * 1024 * 1024) return { ok: false, reason: 'mp4 exceeds 100MB', bytes };
  // The first box should be `ftyp` (bytes 4..8) for a well-formed MP4.
  const tag = buf.subarray(4, 8).toString('latin1');
  if (tag !== 'ftyp') return { ok: false, reason: `missing ftyp box (got "${tag}")`, bytes };
  return { ok: true, bytes };
}

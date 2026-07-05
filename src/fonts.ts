import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

/**
 * Embedded typefaces. Real fonts are the single biggest lever between "designed"
 * and "generic system sans" output. Each latin `woff2` (SIL OFL, vendored under
 * assets/fonts) is base64-encoded into an `@font-face` `data:` URI once, cached,
 * and prepended to the base stylesheet so rendering stays fully offline.
 *
 * Art directions pick faces via the exposed CSS variables:
 *   --font          Inter          (body / default)
 *   --font-display  Space Grotesk  (bold modern grotesk headlines)
 *   --font-serif    Fraunces       (high-contrast editorial serif)
 *   --font-mono     Space Mono     (raw technical / brutalist)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.resolve(__dirname, '..', 'assets', 'fonts');

interface FaceSpec {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  file: string;
}

const FACES: FaceSpec[] = [
  { family: 'Inter', weight: 400, style: 'normal', file: 'Inter-400.woff2' },
  { family: 'Inter', weight: 600, style: 'normal', file: 'Inter-600.woff2' },
  { family: 'Inter', weight: 700, style: 'normal', file: 'Inter-700.woff2' },
  { family: 'Space Grotesk', weight: 500, style: 'normal', file: 'SpaceGrotesk-500.woff2' },
  { family: 'Space Grotesk', weight: 700, style: 'normal', file: 'SpaceGrotesk-700.woff2' },
  { family: 'Fraunces', weight: 600, style: 'normal', file: 'Fraunces-600.woff2' },
  { family: 'Space Mono', weight: 400, style: 'normal', file: 'SpaceMono-400.woff2' },
  { family: 'Space Mono', weight: 700, style: 'normal', file: 'SpaceMono-700.woff2' },
];

let cachedCss: string | null = null;

function faceCss(spec: FaceSpec): string {
  const buf = readFileSync(path.join(FONTS_DIR, spec.file));
  const uri = `data:font/woff2;base64,${buf.toString('base64')}`;
  return (
    `@font-face{font-family:'${spec.family}';font-style:${spec.style};` +
    `font-weight:${spec.weight};font-display:block;` +
    `src:url(${uri}) format('woff2');}`
  );
}

/**
 * All `@font-face` blocks plus the shared font-family CSS variables. Cached after
 * first build. If a face is missing on disk it is skipped (with a warning) rather
 * than failing the render — the stack falls back to the next family.
 */
export function fontFaceCss(): string {
  if (cachedCss !== null) return cachedCss;
  const blocks: string[] = [];
  for (const spec of FACES) {
    try {
      blocks.push(faceCss(spec));
    } catch {
      log.warn('embedded font missing, skipping', { file: spec.file });
    }
  }
  const vars =
    `:root{` +
    `--font:'Inter',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `--font-display:'Space Grotesk','Inter',-apple-system,'Segoe UI',sans-serif;` +
    `--font-serif:'Fraunces',Georgia,'Times New Roman',serif;` +
    `--font-mono:'Space Mono','SFMono-Regular',Menlo,Consolas,monospace;` +
    `}`;
  cachedCss = blocks.join('\n') + '\n' + vars;
  return cachedCss;
}

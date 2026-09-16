/**
 * Dev helper: render the coach avatar in all five states to a standalone HTML file.
 *
 * Run: npx tsx scripts/previewAvatar.tsx
 *
 * Exists because the avatar is the one part of the app you cannot review from a test assertion.
 * Writes .data/avatar-preview.html, which is gitignored.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoachAvatar, type CoachState } from '@/components/session/CoachAvatar';

const STATES: CoachState[] = ['idle', 'listening', 'thinking', 'speaking', 'error'];

const CAPTIONS: Record<CoachState, string> = {
  idle: 'IDLE — waiting for you',
  listening: 'LISTENING — you are speaking (halo tracks mic level)',
  thinking: 'THINKING — processing your turn',
  speaking: 'SPEAKING — mouth animates, head drifts, bars pulse',
  error: 'ERROR — subtle dashed ring, never alarming',
};

function main(): void {
  // Reuse the real animation CSS so the preview matches the app exactly.
  const css = readFileSync('app/globals.css', 'utf8');
  const coachCss = css.slice(css.indexOf('/* ------') === -1 ? 0 : css.indexOf('@keyframes coach-blink'));

  const cards = STATES.map((state) => {
    // createElement rather than JSX: this script runs under plain tsx, which does not apply
    // the project's Next JSX transform.
    const svg = renderToStaticMarkup(
      createElement(CoachAvatar, { state, level: state === 'listening' ? 0.6 : 0 }),
    );
    return `<figure><div class="stage">${svg}</div><figcaption>${CAPTIONS[state]}</figcaption></figure>`;
  }).join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>EngCoach — coach avatar preview</title>
<style>
  :root {
    --color-ink:#0d0f14; --color-surface:#14171f; --color-raised:#1c202b; --color-line:#2a3040;
    --color-text:#e8eaf0; --color-muted:#9aa3b8; --color-dim:#6b7488;
    --color-accent:#7dd3c0; --color-accent-dim:#3d6b62; --color-warm:#e8b88a;
  }
  body { background:var(--color-ink); color:var(--color-text); font-family:system-ui,sans-serif;
         margin:0; padding:40px; }
  h1 { font-size:18px; font-weight:600; margin:0 0 4px; }
  p.sub { color:var(--color-muted); font-size:13px; margin:0 0 32px; }
  .grid { display:flex; flex-wrap:wrap; gap:28px; }
  figure { margin:0; width:230px; }
  .stage { background:var(--color-surface); border:1px solid var(--color-line);
           border-radius:14px; height:230px; display:flex; align-items:center;
           justify-content:center; overflow:hidden; }
  figcaption { color:var(--color-dim); font-size:11px; margin-top:10px; line-height:1.5; }
  .relative{position:relative}.absolute{position:absolute}.flex{display:flex}
  .items-center{align-items:center}.justify-center{justify-content:center}
  .items-end{align-items:flex-end}.rounded-full{border-radius:9999px}
  .h-36{height:9rem}.w-36{width:9rem}
  svg { width:9rem; height:9rem; }
  ${coachCss}
</style></head>
<body>
  <h1>EngCoach — Maya, the coach avatar</h1>
  <p class="sub">A fictional character, hand-authored inline SVG. Animations are live on this page.</p>
  <div class="grid">${cards}</div>
</body></html>`;

  mkdirSync('.data', { recursive: true });
  writeFileSync('.data/avatar-preview.html', html);
  console.log('Wrote .data/avatar-preview.html');
}

main();

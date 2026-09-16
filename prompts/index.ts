/**
 * Prompt loader and version registry — ARCHITECTURE.md §3.3, CLAUDE.md invariant 5.
 *
 * Prompts are versioned files, never inline strings. Every persisted analysis record stores the
 * version that produced it (CLAUDE.md invariant 4), which is what lets the eval harness re-run
 * fixtures against a changed prompt and diff precision. Without versioning, a prompt change is
 * unfalsifiable and the analyzer quietly rots.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPT_DIR = dirname(fileURLToPath(import.meta.url));

export type PromptFrontMatter = {
  id: string;
  version: number;
  changed: string;
  note?: string;
};

export type LoadedPrompt = {
  frontMatter: PromptFrontMatter;
  body: string;
  /** Stable identifier persisted on every record produced with this prompt: "id@version". */
  versionKey: string;
};

const cache = new Map<string, LoadedPrompt>();

/** Minimal YAML front-matter parser. The schema is fixed and tiny; a YAML dep would be overkill. */
function parseFrontMatter(raw: string, relPath: string): { fm: PromptFrontMatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new Error(`Prompt ${relPath} is missing front-matter (--- id/version/changed ---)`);
  }
  const [, header = '', body = ''] = match;

  const fields: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }

  const id = fields.id;
  const versionRaw = fields.version;
  const changed = fields.changed;
  if (!id || !versionRaw || !changed) {
    throw new Error(`Prompt ${relPath} front-matter needs id, version and changed`);
  }
  const version = Number.parseInt(versionRaw, 10);
  if (!Number.isFinite(version)) {
    throw new Error(`Prompt ${relPath} has a non-numeric version "${versionRaw}"`);
  }

  const fm: PromptFrontMatter = { id, version, changed };
  if (fields.note) fm.note = fields.note;
  return { fm, body: body.trim() };
}

export function loadPrompt(relPath: string): LoadedPrompt {
  const cached = cache.get(relPath);
  if (cached) return cached;

  const raw = readFileSync(join(PROMPT_DIR, relPath), 'utf8');
  const { fm, body } = parseFrontMatter(raw, relPath);
  const loaded: LoadedPrompt = {
    frontMatter: fm,
    body,
    versionKey: `${fm.id}@${fm.version}`,
  };
  cache.set(relPath, loaded);
  return loaded;
}

/** Every prompt file in the tree, for the version manifest and for tests. */
export function allPromptFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(join(PROMPT_DIR, dir), { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.name.endsWith('.md')) out.push(rel);
    }
  };
  walk('.', '');
  return out.sort();
}

/** id -> version for everything on disk. Logged with each LlmCall for provenance. */
export function promptVersions(): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const file of allPromptFiles()) {
    const prompt = loadPrompt(file);
    versions[prompt.frontMatter.id] = prompt.frontMatter.version;
  }
  return versions;
}

export function clearPromptCache(): void {
  cache.clear();
}

/**
 * Load `.env.local` / `.env` for standalone scripts — ADR-024.
 *
 * Next.js does this automatically for the app, but a script run under `tsx` gets none of it. The
 * eval harness and the dev helpers therefore ran with an empty configuration and silently used
 * whatever the defaults were — which, for the analyzer eval, meant reporting on the scripted
 * stand-in while the user believed they were measuring their configured model.
 *
 * Precedence matches Next.js: a variable already present in the real environment WINS over the
 * files, so `set FOO=bar && npm run ...` still overrides. Files are read `.env.local` first,
 * then `.env`, and the first definition of a key wins.
 *
 * No dependency: this is a ~40 line parser for a format we already control.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Files in precedence order, highest first. */
const ENV_FILES = ['.env.local', '.env'] as const;

/**
 * Parse one `.env` file's contents.
 *
 * Handles: blank lines, `#` comments, `export KEY=value`, single/double quoted values, and
 * unquoted values with a trailing comment (`FOO=bar   # note`) — that last one matters, because
 * the shipped `.env.example` uses trailing comments and a naive parser would read the comment
 * as part of the value.
 */
export function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();

    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      // Quoted: take it verbatim, so a '#' inside quotes is part of the value.
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      // Unquoted: a '#' preceded by whitespace starts a trailing comment.
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }

    out[key] = value;
  }

  return out;
}

export type LoadedEnv = {
  /** Files that existed and were read, in the order applied. */
  files: string[];
  /** Keys actually set by this call (i.e. not already present in the environment). */
  applied: string[];
};

/**
 * Populate `process.env` from the env files, without overwriting anything already set.
 * Idempotent and safe to call more than once.
 */
export function loadEnvFiles(cwd: string = process.cwd()): LoadedEnv {
  const files: string[] = [];
  const applied: string[] = [];

  for (const name of ENV_FILES) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    files.push(name);

    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(readFileSync(path, 'utf8'));
    } catch {
      // An unreadable env file should not take a script down; the caller reports what loaded.
      continue;
    }

    for (const [key, value] of Object.entries(parsed)) {
      // Real environment and earlier files win — matches Next.js precedence.
      if (process.env[key] !== undefined) continue;
      process.env[key] = value;
      applied.push(key);
    }
  }

  return { files, applied };
}

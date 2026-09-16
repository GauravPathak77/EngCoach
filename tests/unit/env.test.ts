/**
 * The .env loader for standalone scripts — ADR-024.
 *
 * This exists because the analyzer eval silently reported on the scripted stand-in while the
 * user believed they were measuring their configured local model. A parser bug here reintroduces
 * exactly that failure, so the trailing-comment and precedence cases are pinned hard.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFiles, parseEnv } from '@/lib/env';

describe('parsing', () => {
  it('reads plain assignments', () => {
    expect(parseEnv('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips blank lines and full-line comments', () => {
    expect(parseEnv('\n# a comment\n\n  # indented\nFOO=bar\n')).toEqual({ FOO: 'bar' });
  });

  it('strips a TRAILING comment from an unquoted value', () => {
    // The shipped .env.example uses this style. Without stripping, the value becomes
    // "ollama            # all lanes local", which fails provider validation and silently
    // falls back to the scripted stand-in — the exact bug this ADR fixes.
    expect(parseEnv('ENGCOACH_LLM_PROVIDER=ollama            # all lanes local')).toEqual({
      ENGCOACH_LLM_PROVIDER: 'ollama',
    });
  });

  it('keeps a # that is part of the value when there is no preceding space', () => {
    expect(parseEnv('KEY=abc#123')).toEqual({ KEY: 'abc#123' });
  });

  it('keeps a # inside quotes', () => {
    expect(parseEnv('KEY="a # b"')).toEqual({ KEY: 'a # b' });
    expect(parseEnv("KEY='a # b'")).toEqual({ KEY: 'a # b' });
  });

  it('strips surrounding quotes', () => {
    expect(parseEnv('A="one"\nB=\'two\'')).toEqual({ A: 'one', B: 'two' });
  });

  it('accepts an `export` prefix', () => {
    expect(parseEnv('export FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('keeps an empty value as an empty string', () => {
    // Distinct from absent — downstream code treats blank as unset on purpose.
    expect(parseEnv('ANTHROPIC_API_KEY=')).toEqual({ ANTHROPIC_API_KEY: '' });
  });

  it('preserves = inside a value', () => {
    expect(parseEnv('URL=postgres://u:p@h:5432/db?x=1')).toEqual({
      URL: 'postgres://u:p@h:5432/db?x=1',
    });
  });

  it('ignores malformed lines rather than throwing', () => {
    expect(parseEnv('no_equals_here\n=novalue\n1BAD=x\nGOOD=y')).toEqual({ GOOD: 'y' });
  });

  it('handles CRLF line endings', () => {
    expect(parseEnv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('loading into process.env', () => {
  let dir: string;
  const KEYS = ['ENGCOACH_TEST_A', 'ENGCOACH_TEST_B', 'ENGCOACH_TEST_C'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'engcoach-env-'));
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads .env.local', () => {
    writeFileSync(join(dir, '.env.local'), 'ENGCOACH_TEST_A=from-local');
    const result = loadEnvFiles(dir);

    expect(process.env.ENGCOACH_TEST_A).toBe('from-local');
    expect(result.files).toEqual(['.env.local']);
    expect(result.applied).toContain('ENGCOACH_TEST_A');
  });

  it('NEVER overwrites a variable already in the real environment', () => {
    // So `set FOO=bar && npm run ...` still wins, matching Next.js precedence.
    process.env.ENGCOACH_TEST_A = 'from-shell';
    writeFileSync(join(dir, '.env.local'), 'ENGCOACH_TEST_A=from-file');
    const result = loadEnvFiles(dir);

    expect(process.env.ENGCOACH_TEST_A).toBe('from-shell');
    expect(result.applied).not.toContain('ENGCOACH_TEST_A');
  });

  it('lets .env.local beat .env', () => {
    writeFileSync(join(dir, '.env'), 'ENGCOACH_TEST_A=base\nENGCOACH_TEST_B=only-in-base');
    writeFileSync(join(dir, '.env.local'), 'ENGCOACH_TEST_A=override');
    loadEnvFiles(dir);

    expect(process.env.ENGCOACH_TEST_A).toBe('override');
    expect(process.env.ENGCOACH_TEST_B).toBe('only-in-base');
  });

  it('reports no files when none exist, without throwing', () => {
    const result = loadEnvFiles(dir);
    expect(result.files).toEqual([]);
    expect(result.applied).toEqual([]);
  });

  it('is idempotent', () => {
    writeFileSync(join(dir, '.env.local'), 'ENGCOACH_TEST_A=once');
    loadEnvFiles(dir);
    const second = loadEnvFiles(dir);

    expect(process.env.ENGCOACH_TEST_A).toBe('once');
    // Already set by the first call, so the second applies nothing.
    expect(second.applied).not.toContain('ENGCOACH_TEST_A');
  });

  it('loads a realistic file end to end', () => {
    writeFileSync(
      join(dir, '.env.local'),
      [
        '# EngCoach environment',
        'ENGCOACH_TEST_A=ollama            # all lanes local',
        '',
        '# ENGCOACH_TEST_B=commented-out',
        'ENGCOACH_TEST_C=qwen2.5:7b-instruct',
      ].join('\n'),
    );
    loadEnvFiles(dir);

    expect(process.env.ENGCOACH_TEST_A).toBe('ollama');
    expect(process.env.ENGCOACH_TEST_B).toBeUndefined();
    expect(process.env.ENGCOACH_TEST_C).toBe('qwen2.5:7b-instruct');
  });
});

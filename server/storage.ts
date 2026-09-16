/**
 * Audio object storage.
 *
 * Local filesystem in V1. Audio lives for at most 24 hours (ADR-015) and this is a self-hosted
 * single-user app, so an object-store dependency would buy nothing. The interface is small
 * enough that swapping in R2 or Supabase Storage is a single file.
 *
 * Storing audio at all is OPT-IN (`settings.retainAudio`); the default discards the bytes as
 * soon as the transcript exists.
 */

import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(process.env.ENGCOACH_AUDIO_DIR ?? './.data/audio');

function pathFor(key: string): string {
  // Keys are generated internally, but a traversal guard costs nothing and this writes to disk.
  const safe = key.replace(/[^A-Za-z0-9._/-]/g, '');
  const full = resolve(join(ROOT, safe));
  if (!full.startsWith(ROOT)) throw new Error('Invalid audio key');
  return full;
}

export async function putAudio(key: string, data: Buffer): Promise<string> {
  const path = pathFor(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return key;
}

export async function getAudio(key: string): Promise<Buffer | null> {
  const path = pathFor(key);
  if (!existsSync(path)) return null;
  return readFile(path);
}

export async function deleteAudio(key: string): Promise<void> {
  const path = pathFor(key);
  await rm(path, { force: true });
}

export function audioKeyFor(userId: string, sessionId: string, turnId: string): string {
  return `${userId}/${sessionId}/${turnId}.webm`;
}

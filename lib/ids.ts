/**
 * Time-sortable identifiers.
 *
 * uuid v7 layout: 48-bit millisecond timestamp then random. Sorting by id sorts by creation
 * time, which is what makes the transcript and findings queries cheap (DATA_MODEL.md §1).
 */

import { randomBytes } from 'node:crypto';

export function newId(): string {
  const now = Date.now();
  const time = now.toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');

  const timeLow = time.slice(0, 8);
  const timeMid = time.slice(8, 12);
  // Version 7, variant 10xx.
  const verAndRand = `7${rand.slice(0, 3)}`;
  const varAndRand = ((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16) + rand.slice(4, 7);

  return `${timeLow}-${timeMid}-${verAndRand}-${varAndRand}-${rand.slice(7, 19)}`;
}

/** Short, human-scannable id for utterances inside an analyzer batch. */
export function shortId(prefix: string, n: number): string {
  return `${prefix}${n}`;
}

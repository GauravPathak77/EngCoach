/**
 * Dev helper: report what a local Ollama setup actually offers.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/checkOllama.ts
 */

import { loadEnvFiles } from '@/lib/env';
import { ollamaStatus } from '@/lib/llm/ollama';
import { providerSummary } from '@/lib/llm/providers';
import { modelSummary } from '@/lib/llm/models';

async function main(): Promise<void> {
  // tsx does not load .env.local the way Next.js does (ADR-024).
  const loaded = loadEnvFiles();
  const status = await ollamaStatus();
  console.log('');
  console.log(`  env file(s): ${loaded.files.join(' + ') || 'none found'}`);
  console.log('');
  console.log('  Ollama');
  console.log('  ------');
  console.log(`  reachable : ${status.reachable}`);
  console.log(`  models    : ${status.models.length > 0 ? status.models.join(', ') : '(none)'}`);
  console.log(`  note      : ${status.message}`);
  console.log('');
  console.log('  Lane routing with the current environment:');
  const lanes = providerSummary();
  const models = modelSummary();
  for (const lane of ['hot', 'cold', 'session'] as const) {
    const pulled = lanes[lane] !== 'ollama' || status.models.includes(models[lane]);
    console.log(
      `    ${lane.padEnd(8)} ${lanes[lane].padEnd(10)} ${models[lane].padEnd(24)} ${pulled ? '' : '<- NOT PULLED'}`,
    );
  }
  console.log('');
}

void main();

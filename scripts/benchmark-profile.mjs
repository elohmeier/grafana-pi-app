#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { piModelOptions, printModels, readPiModels, selectModel } from './configure-pi-model.mjs';
import { createProfile } from './benchmarks/profile.mjs';

async function main() {
  const { values } = parseArgs({
    options: {
      ...piModelOptions,
      output: { type: 'string' },
      label: { type: 'string' },
      'hosting-label': { type: 'string' },
      region: { type: 'string' },
      'service-tier': { type: 'string' },
      repetitions: { type: 'string' },
      suites: { type: 'string' },
      notes: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(`Usage: npm run benchmark:profile -- --list
       npm run benchmark:profile -- --provider NAME --model ID [--output FILE] [--dry-run]

Reads the same Pi models.json as dev:model. Generates one benchmark profile.
Model options: --models-file PATH, --thinking off|low|medium|high,
               --thinking-format openai|qwen|qwen-chat-template,
               --base-url URL (also disables Docker loopback rewriting).
Profile options: --label TEXT, --hosting-label TEXT, --region TEXT, --service-tier TEXT,
                 --repetitions N (default 1), --suites agent,analysis, --notes TEXT.
Output defaults to benchmarks/<provider>-<model>-<thinking>.json; existing files are never overwritten.
Pi credentials are referenced by file path and resolved only when benchmark:run executes.
Use --api-key-env NAME to use an environment variable instead.
--dry-run prints JSON without writing a file. Creation/list/preview never resolve keys or contact Grafana.`);
    return;
  }
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envPath)) {
    loadEnvFile(envPath);
  }
  const models = await readPiModels(values['models-file']);
  if (values.list || (!values.provider && !values.model)) {
    printModels(models);
    return;
  }
  const profile = createProfile(selectModel(models, values), values);
  const json = JSON.stringify(profile, null, 2) + '\n';
  if (values['dry-run']) {
    process.stdout.write(json);
    return;
  }
  const filename = `${profile.model.provider}-${profile.model.id}-${profile.model.thinkingLevel}`.replace(
    /[^A-Za-z0-9._-]+/g,
    '-'
  );
  const output = values.output ?? path.join('benchmarks', `${filename}.json`);
  await mkdir(path.dirname(output), { recursive: true });
  try {
    await writeFile(output, json, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Profile already exists: ${output}. Edit it or choose another --output.`);
    }
    throw error;
  }
  console.log(`Created ${output}`);
  // Quote the path for copy/pasting in the shell, including user-supplied filenames.
  const quotedOutput = `'${output.replaceAll("'", "'\\''")}'`;
  console.log(`Preview: npm run benchmark:run -- --config ${quotedOutput} --dry-run`);
  console.log(`Run:     npm run benchmark:run -- --config ${quotedOutput}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

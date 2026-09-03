#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const usage = 'Usage: node scripts/repeat-command.mjs --runs <positive-integer> -- <command> [args...]';
const separator = process.argv.indexOf('--', 2);

if (separator === -1) failUsage('Missing command separator (`--`).');

const options = process.argv.slice(2, separator);
const command = process.argv[separator + 1];
const commandArguments = process.argv.slice(separator + 2);
let runs;

for (let index = 0; index < options.length; index += 1) {
  if (options[index] !== '--runs' || index + 1 >= options.length || runs !== undefined) {
    failUsage(`Unexpected option: ${options[index] ?? ''}`);
  }
  runs = Number(options[index + 1]);
  index += 1;
}

if (!Number.isSafeInteger(runs) || runs <= 0) failUsage('--runs must be a positive integer.');
if (!command) failUsage('A command is required after `--`.');

for (let run = 1; run <= runs; run += 1) {
  process.stdout.write(`repeat-command: run ${run}/${runs}\n`);
  const result = spawnSync(command, commandArguments, {
    env: process.env,
    shell: false,
    stdio: 'inherit'
  });
  if (result.error) {
    process.stderr.write(`repeat-command: ${result.error.message}\n`);
    process.exitCode = 1;
    break;
  }
  if (result.status !== 0) {
    const detail = result.signal === null ? `exit ${result.status ?? 1}` : `signal ${result.signal}`;
    process.stderr.write(`repeat-command: stopped after run ${run}/${runs} (${detail})\n`);
    process.exitCode = result.status ?? 1;
    break;
  }
}

function failUsage(message) {
  process.stderr.write(`repeat-command: ${message}\n${usage}\n`);
  process.exit(2);
}

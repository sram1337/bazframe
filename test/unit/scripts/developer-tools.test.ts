import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDirectory } from '../../helpers/temp-directory.js';

const repeatCommand = join(process.cwd(), 'scripts', 'repeat-command.mjs');
const summarizeSession = join(process.cwd(), 'scripts', 'summarize-pi-session.mjs');

describe('developer utility scripts', () => {
  it('repeats a command the requested number of times', async () => {
    const directory = await createTempDirectory();
    try {
      const countPath = directory.path('count.txt');
      const increment = "const{readFileSync,writeFileSync}=require('node:fs');const p=process.argv[1];let n=0;try{n=Number(readFileSync(p,'utf8'))}catch{}writeFileSync(p,String(n+1));";
      const result = spawnSync(process.execPath, [
        repeatCommand, '--runs', '3', '--', process.execPath, '-e', increment, countPath
      ], { encoding: 'utf8', shell: false });

      expect(result).toMatchObject({ status: 0, stderr: '' });
      expect(result.stdout).toContain('repeat-command: run 3/3');
      expect(await readFile(countPath, 'utf8')).toBe('3');
    } finally {
      await directory.cleanup();
    }
  });

  it('stops repeating after the first failed command', () => {
    const result = spawnSync(process.execPath, [
      repeatCommand, '--runs', '3', '--', process.execPath, '-e', 'process.exit(7)'
    ], { encoding: 'utf8', shell: false });

    expect(result.status).toBe(7);
    expect(result.stdout).toContain('repeat-command: run 1/3');
    expect(result.stdout).not.toContain('run 2/3');
    expect(result.stderr).toContain('stopped after run 1/3 (exit 7)');
  });

  it('summarizes repeated commands, file reads, and actual async subagent launches', async () => {
    const directory = await createTempDirectory();
    try {
      const sessionPath = directory.path('session.jsonl');
      const entries = [
        message('2026-01-01T00:00:00.000Z', 'assistant', [
          toolCall('read-1', 'read', { path: '/repo/a.ts' }),
          toolCall('bash-1', 'bash', { command: 'npm run typecheck' }),
          toolCall('subagent-1', 'subagent', { agent: 'worker', task: 'Implement', context: 'fork', async: true })
        ]),
        toolResult('2026-01-01T00:00:01.000Z', 'read-1', 'read', 'ok'),
        toolResult('2026-01-01T00:00:02.000Z', 'bash-1', 'bash', 'ok'),
        toolResult('2026-01-01T00:00:03.000Z', 'subagent-1', 'subagent', 'Async run started', { asyncId: 'run-1' }),
        message('2026-01-01T00:00:04.000Z', 'assistant', [
          toolCall('read-2', 'read', { path: '/repo/a.ts' }),
          toolCall('bash-2', 'bash', { command: 'npm   run typecheck' })
        ]),
        toolResult('2026-01-01T00:00:05.000Z', 'read-2', 'read', 'ok'),
        toolResult('2026-01-01T00:00:06.000Z', 'bash-2', 'bash', 'ok')
      ];
      await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

      const result = spawnSync(process.execPath, [summarizeSession, sessionPath], { encoding: 'utf8', shell: false });
      expect(result).toMatchObject({ status: 0, stderr: '' });
      const summary = JSON.parse(result.stdout);
      expect(summary.session).toMatchObject({ entries: 7, durationSeconds: 6 });
      expect(summary.bash).toMatchObject({
        routineCalls: { typecheck: 2 },
        repeatedCommands: [{ count: 2, command: 'npm run typecheck' }]
      });
      expect(summary.subagents).toMatchObject({
        executionCalls: 1,
        declaredTasks: 1,
        launchResponses: { 'async-detached': 1 },
        declaredAgents: { worker: 1 }
      });
      expect(summary.repeatedFileOperations.reads).toEqual([{ count: 2, path: '/repo/a.ts' }]);
    } finally {
      await directory.cleanup();
    }
  });
});

function message(timestamp: string, role: string, content: unknown[]) {
  return { type: 'message', timestamp, message: { role, content } };
}

function toolCall(id: string, name: string, argumentsValue: Record<string, unknown>) {
  return { type: 'toolCall', id, name, arguments: argumentsValue };
}

function toolResult(timestamp: string, toolCallId: string, toolName: string, text: string, details: Record<string, unknown> = {}) {
  return {
    type: 'message',
    timestamp,
    message: {
      role: 'toolResult',
      toolCallId,
      toolName,
      content: [{ type: 'text', text }],
      details,
      isError: false
    }
  };
}

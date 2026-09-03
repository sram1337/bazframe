#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const sessionArgument = process.argv[2];
if (process.argv.length !== 3 || !sessionArgument) {
  process.stderr.write('Usage: node scripts/summarize-pi-session.mjs <session.jsonl>\n');
  process.exit(2);
}

const sessionPath = resolve(sessionArgument);
try {
  await access(sessionPath);
  const summary = await summarizeSession(sessionPath);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`summarize-pi-session: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function summarizeSession(path) {
  const counters = {
    roles: new Map(),
    tools: new Map(),
    toolErrors: new Map(),
    toolBlockingSeconds: new Map(),
    bashRoutines: new Map(),
    commands: new Map(),
    reads: new Map(),
    edits: new Map(),
    writes: new Map(),
    subagentModes: new Map(),
    subagentContexts: new Map(),
    subagentSchedulingArguments: new Map(),
    subagentLaunchResponses: new Map(),
    subagentAgents: new Map(),
    subagentProblemIndicators: new Map()
  };
  const pendingCalls = new Map();
  let entries = 0;
  let messages = 0;
  let malformedLine;
  let firstTimestamp;
  let lastTimestamp;
  let subagentExecutionCalls = 0;
  let subagentManagementCalls = 0;
  let declaredSubagentTasks = 0;

  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    entries += 1;
    let entry;
    try { entry = JSON.parse(line); }
    catch { malformedLine = entries; break; }

    if (typeof entry.timestamp === 'string') {
      firstTimestamp ??= entry.timestamp;
      lastTimestamp = entry.timestamp;
    }
    if (entry.type !== 'message' || typeof entry.message !== 'object' || entry.message === null) continue;
    messages += 1;
    const message = entry.message;
    increment(counters.roles, String(message.role ?? 'unknown'));

    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item?.type !== 'toolCall') continue;
        const tool = normalizedToolName(item.name);
        increment(counters.tools, tool);
        if (typeof item.id === 'string') {
          pendingCalls.set(item.id, { tool, timestamp: timestampMilliseconds(entry.timestamp), subagentExecution: false });
        }
        const argumentsValue = isRecord(item.arguments) ? item.arguments : {};
        recordFileOperation(tool, argumentsValue, counters);
        if (tool === 'bash') recordBash(argumentsValue.command, counters);
        if (tool === 'subagent') {
          if (typeof argumentsValue.action === 'string') {
            subagentManagementCalls += 1;
          } else {
            subagentExecutionCalls += 1;
            const mode = Array.isArray(argumentsValue.tasks) ? 'parallel' : Array.isArray(argumentsValue.chain) ? 'chain' : 'single';
            increment(counters.subagentModes, mode);
            increment(counters.subagentContexts, typeof argumentsValue.context === 'string' ? argumentsValue.context : 'agent-default');
            increment(counters.subagentSchedulingArguments, argumentsValue.async === true ? 'async' : argumentsValue.async === false ? 'foreground' : 'default');
            const taskCount = recordDeclaredAgents(argumentsValue, counters.subagentAgents);
            declaredSubagentTasks += taskCount;
            const pending = pendingCalls.get(item.id);
            if (pending) pending.subagentExecution = true;
          }
        }
      }
    }

    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const tool = normalizedToolName(message.toolName);
      if (message.isError === true) increment(counters.toolErrors, tool);
      const pending = pendingCalls.get(message.toolCallId);
      if (pending) {
        const ended = timestampMilliseconds(entry.timestamp);
        if (pending.timestamp !== undefined && ended !== undefined && ended >= pending.timestamp) {
          add(counters.toolBlockingSeconds, pending.tool, (ended - pending.timestamp) / 1000);
        }
        if (pending.subagentExecution) {
          const details = isRecord(message.details) ? message.details : {};
          const text = contentText(message.content);
          increment(counters.subagentLaunchResponses,
            message.isError === true ? 'error'
              : typeof details.asyncId === 'string' ? 'async-detached'
                : 'foreground-returned');
          if (/timed out|exceeded (?:the )?turn budget|turn budget exceeded/iu.test(text)) {
            increment(counters.subagentProblemIndicators, 'timeout-or-turn-budget');
          }
          if (/overloaded|no api key|failed to start|unknown agent|adapter failed/iu.test(text)) {
            increment(counters.subagentProblemIndicators, 'provider-or-launch-failure');
          }
        }
        pendingCalls.delete(message.toolCallId);
      }
    }
  }

  if (malformedLine !== undefined) throw new Error(`invalid JSON on nonempty line ${malformedLine}`);
  const started = timestampMilliseconds(firstTimestamp);
  const ended = timestampMilliseconds(lastTimestamp);
  const unresolvedSubagentCalls = [...pendingCalls.values()].filter((call) => call.subagentExecution).length;
  if (unresolvedSubagentCalls > 0) add(counters.subagentLaunchResponses, 'unresolved', unresolvedSubagentCalls);

  return {
    session: {
      path,
      entries,
      messages,
      startedAt: firstTimestamp ?? null,
      endedAt: lastTimestamp ?? null,
      durationSeconds: started !== undefined && ended !== undefined ? (ended - started) / 1000 : null
    },
    messagesByRole: sortedObject(counters.roles),
    tools: {
      callsByName: sortedObject(counters.tools),
      errorResultsByName: sortedObject(counters.toolErrors),
      cumulativeBlockingSecondsByName: roundedObject(counters.toolBlockingSeconds)
    },
    bash: {
      routineCalls: sortedObject(counters.bashRoutines),
      repeatedCommands: repeatedEntries(counters.commands, 'command')
    },
    subagents: {
      executionCalls: subagentExecutionCalls,
      managementCalls: subagentManagementCalls,
      declaredTasks: declaredSubagentTasks,
      modes: sortedObject(counters.subagentModes),
      requestedContexts: sortedObject(counters.subagentContexts),
      schedulingArguments: sortedObject(counters.subagentSchedulingArguments),
      launchResponses: sortedObject(counters.subagentLaunchResponses),
      declaredAgents: sortedObject(counters.subagentAgents),
      problemIndicators: sortedObject(counters.subagentProblemIndicators)
    },
    repeatedFileOperations: {
      reads: repeatedEntries(counters.reads, 'path'),
      edits: repeatedEntries(counters.edits, 'path'),
      writes: repeatedEntries(counters.writes, 'path')
    }
  };
}

function recordFileOperation(tool, argumentsValue, counters) {
  if (!['read', 'edit', 'write'].includes(tool) || typeof argumentsValue.path !== 'string') return;
  const target = tool === 'read' ? counters.reads : tool === 'edit' ? counters.edits : counters.writes;
  increment(target, argumentsValue.path);
}

function recordBash(commandValue, counters) {
  if (typeof commandValue !== 'string') return;
  const command = commandValue.replace(/\s+/gu, ' ').trim();
  increment(counters.commands, command);
  const routines = [
    ['build', /\bnpm (?:run )?build\b/u],
    ['git-diff', /\bgit diff\b/u],
    ['git-status', /\bgit status\b/u],
    ['integration-test', /\bnpm run test:integration\b|\bvitest run --config vitest\.integration/u],
    ['lint', /\bnpm run lint\b|\bnpx eslint\b/u],
    ['pack', /\bnpm run test:pack\b|\bnpm pack\b/u],
    ['ripgrep', /(?:^|[;&|]\s*|\s)rg\s/u],
    ['typecheck', /\bnpm run typecheck\b/u],
    ['unit-test', /\bnpm run test:unit\b|\bvitest run --config vitest\.config/u]
  ];
  for (const [name, pattern] of routines) if (pattern.test(command)) increment(counters.bashRoutines, name);
}

function recordDeclaredAgents(argumentsValue, agents) {
  let count = 0;
  const record = (task) => {
    if (!isRecord(task) || typeof task.agent !== 'string') return;
    const repetitions = Number.isSafeInteger(task.count) && task.count > 0 ? task.count : 1;
    add(agents, task.agent, repetitions);
    count += repetitions;
  };
  if (Array.isArray(argumentsValue.tasks)) {
    for (const task of argumentsValue.tasks) record(task);
  } else if (typeof argumentsValue.agent === 'string') {
    record(argumentsValue);
  }
  if (Array.isArray(argumentsValue.chain)) {
    for (const step of argumentsValue.chain) {
      record(step);
      if (Array.isArray(step?.parallel)) for (const task of step.parallel) record(task);
      else if (isRecord(step?.parallel)) record(step.parallel);
    }
  }
  return count;
}

function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content.map((item) => item?.type === 'text' && typeof item.text === 'string' ? item.text : '').join('\n');
}

function normalizedToolName(value) {
  if (typeof value !== 'string' || value === '') return 'unknown';
  return value.split('.').at(-1);
}

function timestampMilliseconds(value) {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function increment(map, key) { add(map, key, 1); }
function add(map, key, amount) { map.set(key, (map.get(key) ?? 0) + amount); }
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function sortedObject(map) { return Object.fromEntries([...map].sort(([left], [right]) => left.localeCompare(right))); }
function roundedObject(map) { return Object.fromEntries([...map].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, Math.round(value * 1000) / 1000])); }
function repeatedEntries(map, keyName) {
  return [...map]
    .filter(([, count]) => count > 1)
    .sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey))
    .map(([key, count]) => ({ count, [keyName]: key }));
}

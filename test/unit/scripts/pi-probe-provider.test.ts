import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const filename = 'scripts/fixtures/pi-probe-provider.ts';
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

type Event = { type: string; [key: string]: unknown };
type Provider = { streamSimple: (model: object, context: unknown) => unknown };

// Fixture wiring only: no Pi process, provider network call or installed-runtime admission.
async function probe(context: unknown, transcriptApi: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const events: Event[] = [], captures: Array<{ path: string; text: string }> = [];
  let ended = false, provider: Provider | undefined;
  const exports: { default?: (api: object) => void } = {};
  new Script(compiled, { filename }).runInNewContext({
    exports, queueMicrotask, Error,
    process: { env: { BAZFRAME_PI_PROBE_CAPTURE: '/probe/capture.jsonl', ...env }, cwd: () => '/probe' },
    require: (name: string) => {
      if (name === 'node:fs') return { appendFileSync: (path: string, text: string) => { captures.push({ path, text }); } };
      if (name === '@earendil-works/pi-ai') return {
        ...transcriptApi,
        createAssistantMessageEventStream: () => ({
          push: (event: Event) => { events.push(event); }, end: () => { ended = true; }
        })
      };
      throw new Error(`Unexpected fixture dependency: ${name}`);
    }
  });
  exports.default?.({ registerProvider: (_name: string, registered: Provider) => { provider = registered; } });
  if (provider === undefined) throw new Error('Probe was not registered');
  provider.streamSimple({ api: 'openai-completions', provider: 'bazframe-probe', id: 'probe' }, context);
  await new Promise<void>(resolve => queueMicrotask(resolve));
  return { events, captures, ended };
}

function expectCapture(result: Awaited<ReturnType<typeof probe>>, systemPrompt: string, skills: number) {
  expect(result.captures).toHaveLength(1);
  expect(result.captures[0]?.path).toBe('/probe/capture.jsonl');
  expect(JSON.parse(result.captures[0]?.text ?? '')).toEqual({ cwd: '/probe', systemPrompt, skills });
  expect(result.events.map(event => event.type)).toEqual(['start', 'text_start', 'text_delta', 'text_end', 'done']);
  expect(result.events.at(-1)?.message).toMatchObject({ content: [{ type: 'text', text: 'probe-ok' }], stopReason: 'stop' });
  expect(result.ended).toBe(true);
}

describe('offline Pi probe context compatibility', () => {
  const readEnv = { BAZFRAME_PI_PROBE_MESSAGES: '1', BAZFRAME_PI_PROBE_READ: '/admitted/artifact/shared/resource.txt' };
  it('retains default one-capture text-only behavior even with conversation and tool history', async () => {
    expectCapture(await probe({ systemPrompt: 'ordinary', messages: [{ role: 'user', content: 'ordinary task' }, { role: 'toolResult', toolCallId: 'unrelated', toolName: 'read', isError: false, content: [] }] }), 'ordinary', 0);
  });
  it('emits one opt-in installed read request without reading or inventing its result', async () => {
    const messages = [{ role: 'user', content: 'expanded Skill' }];
    const result = await probe({ systemPrompt: 'context', messages }, {}, readEnv);
    expect(result.captures).toHaveLength(1);
    expect(JSON.parse(result.captures[0]!.text).messages).toEqual(messages);
    expect(result.events.map(event => event.type)).toEqual(['start', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done']);
    expect(result.events.at(-1)).toMatchObject({ reason: 'toolUse', message: { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'bazframe-support-read', name: 'read', arguments: { path: readEnv.BAZFRAME_PI_PROBE_READ } }] } });
    expect(result.ended).toBe(true);
  });
  it('consumes the supplied Pi read result without issuing another tool call', async () => {
    const messages = [{ role: 'toolResult', toolCallId: 'bazframe-support-read', toolName: 'read', isError: false, content: [{ type: 'text', text: 'resource bytes' }] }];
    const result = await probe({ messages }, { getCurrentSystemPrompt: () => 'transcript' }, readEnv);
    expect(JSON.parse(result.captures[0]!.text).messages).toEqual(messages);
    expect(result.events.at(-1)).toMatchObject({ reason: 'stop', message: { content: [{ type: 'text', text: 'probe-ok' }] } });
    expect(result.events.some(event => event.type.startsWith('toolcall'))).toBe(false);
  });
  it.each([
    [{ toolCallId: 'other', toolName: 'read', isError: false }],
    [{ toolCallId: 'bazframe-support-read', toolName: 'bash', isError: false }],
    [{ toolCallId: 'bazframe-support-read', toolName: 'read', isError: true }],
    [{ toolCallId: 'bazframe-support-read', toolName: 'read' }],
    [{ toolCallId: 'bazframe-support-read', toolName: 'read', isError: false }, { toolCallId: 'extra' }]
  ].map(rows => ({ rows })))('refuses uncorrelated/error/duplicate tool results $rows', async ({ rows }) => {
    const result = await probe({ systemPrompt: '', messages: rows.map(row => ({ role: 'toolResult', ...row })) }, {}, readEnv);
    expect(result.events.at(-1)).toMatchObject({ type: 'error' });
    expect(result.events.some(event => event.type.startsWith('toolcall'))).toBe(false);
  });
  it.each([{ BAZFRAME_PI_PROBE_READ: '/unadmitted' }, { ...readEnv, BAZFRAME_PI_PROBE_READ: '' }])('requires explicit capture and nonempty read admission', async env => {
    const result = await probe({ systemPrompt: '', messages: [] }, {}, env);
    expect(result.events.at(-1)).toMatchObject({ type: 'error' });
  });
  it.each(['base <skill>one</skill> <skill>two</skill>', ''])('preserves a supplied legacy prompt %j without a new API', async systemPrompt => {
    expectCapture(await probe({ systemPrompt, messages: [] }), systemPrompt, systemPrompt === '' ? 0 : 2);
  });

  it('uses the documented transcript reader on the actual messages, for both capture and Skill count', async () => {
    const systemPrompt = 'current <skill>first</skill> <skill>second</skill>';
    const messages = [{ role: 'system', content: [{ type: 'text', text: systemPrompt }] }];
    const readPrompt = vi.fn(() => systemPrompt);
    expectCapture(await probe({ messages }, { getCurrentSystemPrompt: readPrompt }), systemPrompt, 2);
    expect(readPrompt).toHaveBeenCalledExactlyOnceWith(messages);
  });

  it.each([
    [{ messages: [] }, {}],
    [{ messages: [] }, { getCurrentSystemPrompt: (): undefined => undefined }],
    [{ messages: null }, { getCurrentSystemPrompt: (): string => 'invented' }]
  ])('reports unsupported context/API instead of manufacturing an empty capture', async (context, api) => {
    const result = await probe(context, api);
    expect(result.captures).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'error', reason: 'error', error: { stopReason: 'error' } });
    expect(result.ended).toBe(true);
  });
});

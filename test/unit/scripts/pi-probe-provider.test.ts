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
async function probe(context: unknown, transcriptApi: Record<string, unknown> = {}) {
  const events: Event[] = [], captures: Array<{ path: string; text: string }> = [];
  let ended = false, provider: Provider | undefined;
  const exports: { default?: (api: object) => void } = {};
  new Script(compiled, { filename }).runInNewContext({
    exports, queueMicrotask, Error,
    process: { env: { BAZFRAME_PI_PROBE_CAPTURE: '/probe/capture.jsonl' }, cwd: () => '/probe' },
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

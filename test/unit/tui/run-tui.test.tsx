import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TuiAppProps } from '../../../src/tui/app.js';

const renderMock = vi.hoisted(() => vi.fn());

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, render: renderMock };
});

import { runTui, type RunTuiOptions } from '../../../src/tui/run-tui.js';

describe('TUI process termination lifecycle', () => {
  it('unmounts, flushes the plain warning, then invokes the injected force termination', async () => {
    const events: string[] = [];
    let finishWait!: () => void;
    let finishFlush!: (error?: Error | null) => void;
    const wait = new Promise<void>((resolve) => {
      finishWait = resolve;
    });
    const instance = {
      waitUntilExit: vi.fn(async () => {
        events.push('wait');
        await wait;
        events.push('wait-complete');
      }),
      unmount: vi.fn(() => {
        events.push('unmount');
      })
    };
    const stderr = {
      write: vi.fn((text: string, callback?: (error?: Error | null) => void) => {
        events.push(`warning:${text}`);
        finishFlush = callback ?? (() => undefined);
        return true;
      })
    } as unknown as NodeJS.WriteStream;
    const terminateProcess = vi.fn((status: number) => {
      events.push(`terminate:${status}`);
    });
    renderMock.mockImplementationOnce((node: ReactElement<TuiAppProps>) => {
      node.props.onExitCode?.(130);
      node.props.onForceExit?.();
      return instance;
    });

    const result = runTui(options({ stderr, terminateProcess }));
    await vi.waitFor(() => expect(instance.waitUntilExit).toHaveBeenCalledOnce());
    expect(events).toEqual(['wait']);

    finishWait();
    await vi.waitFor(() => expect(stderr.write).toHaveBeenCalledOnce());
    expect(events).toEqual([
      'wait',
      'wait-complete',
      'unmount',
      'warning:warning: forced exit; the in-flight operation outcome may be unknown.\n'
    ]);
    expect(terminateProcess).not.toHaveBeenCalled();

    finishFlush();
    await expect(result).resolves.toBe(130);
    expect(events).toEqual([
      'wait',
      'wait-complete',
      'unmount',
      'warning:warning: forced exit; the in-flight operation outcome may be unknown.\n',
      'terminate:130'
    ]);
    expect(instance.unmount).toHaveBeenCalledOnce();
  });

  it('does not invoke process termination for a non-forced interrupted return', async () => {
    const instance = {
      waitUntilExit: vi.fn(async () => undefined),
      unmount: vi.fn()
    };
    const stderr = { write: vi.fn(() => true) } as unknown as NodeJS.WriteStream;
    const terminateProcess = vi.fn();
    renderMock.mockImplementationOnce((node: ReactElement<TuiAppProps>) => {
      node.props.onExitCode?.(130);
      return instance;
    });

    await expect(runTui(options({ stderr, terminateProcess }))).resolves.toBe(130);

    expect(instance.unmount).toHaveBeenCalledOnce();
    expect(stderr.write).not.toHaveBeenCalled();
    expect(terminateProcess).not.toHaveBeenCalled();
  });

  it('unmounts before reporting a rejected renderer wait without terminating the process', async () => {
    const events: string[] = [];
    let rejectWait!: (error: Error) => void;
    const wait = new Promise<void>((_resolve, reject) => {
      rejectWait = reject;
    });
    const instance = {
      waitUntilExit: vi.fn(async () => {
        events.push('wait');
        await wait;
      }),
      unmount: vi.fn(() => {
        events.push('unmount');
      })
    };
    const stderr = {
      write: vi.fn((text: string) => {
        events.push(`diagnostic:${text}`);
        return true;
      })
    } as unknown as NodeJS.WriteStream;
    const terminateProcess = vi.fn();
    renderMock.mockReturnValueOnce(instance);

    const result = runTui(options({ stderr, terminateProcess }));
    await vi.waitFor(() => expect(instance.waitUntilExit).toHaveBeenCalledOnce());
    expect(events).toEqual(['wait']);

    events.push('reject');
    rejectWait(new Error('renderer wait failed'));

    await expect(result).resolves.toBe(1);
    expect(events).toEqual([
      'wait',
      'reject',
      'unmount',
      'diagnostic:error: renderer wait failed\n'
    ]);
    expect(instance.unmount).toHaveBeenCalledOnce();
    expect(terminateProcess).not.toHaveBeenCalled();
  });
});

function options(overrides: Pick<RunTuiOptions, 'stderr' | 'terminateProcess'>): RunTuiOptions {
  return {
    bazframeHome: '/bazframe-home',
    bazframeVersion: 'test',
    cwd: '/working-directory',
    environment: {},
    stdin: {} as NodeJS.ReadStream,
    stdout: {} as NodeJS.WriteStream,
    ...overrides
  };
}

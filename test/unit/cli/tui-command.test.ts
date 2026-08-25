import { describe, expect, it, vi } from 'vitest';
import { VERSION } from '../../../src/cli/help.js';
import { runCli } from '../../../src/cli/run-cli.js';

describe('tui command', () => {
  it.each([
    [false, true],
    [true, false],
    [false, false]
  ])('rejects non-interactive stdin=%s stdout=%s before loading Ink', async (
    stdinIsTty,
    stdoutIsTty
  ) => {
    const launchTui = vi.fn(async () => 0);
    const terminateProcess = vi.fn();
    let stdout = '';
    let stderr = '';

    const status = await runCli(['tui'], {
      environment: { BAZFRAME_HOME: '/unused' },
      stdinIsTty,
      stdoutIsTty,
      stderrIsTty: true,
      terminateProcess,
      launchTui,
      writeStdout: (text) => { stdout += text; },
      writeStderr: (text) => { stderr += text; }
    });

    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('requires interactive stdin and stdout');
    expect(stderr).not.toContain('\u001B');
    expect(launchTui).not.toHaveBeenCalled();
    expect(terminateProcess).not.toHaveBeenCalled();
  });

  it('launches the dynamically supplied TUI only after TTY preflight', async () => {
    const launchTui = vi.fn(async () => 7);
    const terminateProcess = vi.fn();
    const adapterArtifactUrl = new URL('file:///adapter.ts');
    const status = await runCli(['tui'], {
      cwd: () => '/working-directory',
      environment: { BAZFRAME_HOME: '/bazframe-home' },
      adapterArtifactUrl,
      stdinIsTty: true,
      stdoutIsTty: true,
      terminateProcess,
      launchTui,
      writeStdout: vi.fn(),
      writeStderr: vi.fn()
    });

    expect(status).toBe(7);
    expect(launchTui).toHaveBeenCalledOnce();
    expect(launchTui).toHaveBeenCalledWith(expect.objectContaining({
      bazframeHome: '/bazframe-home',
      bazframeVersion: VERSION,
      cwd: '/working-directory',
      environment: { BAZFRAME_HOME: '/bazframe-home' },
      adapterArtifactUrl,
      terminateProcess
    }));
    expect(terminateProcess).not.toHaveBeenCalled();
  });

  it('keeps help non-interactive and does not launch the TUI', async () => {
    const launchTui = vi.fn(async () => 0);
    let stdout = '';
    const status = await runCli(['tui', '--help'], {
      stdinIsTty: false,
      stdoutIsTty: false,
      launchTui,
      writeStdout: (text) => { stdout += text; }
    });

    expect(status).toBe(0);
    expect(stdout).toContain('Usage: bazframe tui');
    expect(launchTui).not.toHaveBeenCalled();
  });
});

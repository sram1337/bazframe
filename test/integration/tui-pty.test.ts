import { spawn, spawnSync } from 'node:child_process';
import { chmod, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const temporaryDirectories: TempDirectory[] = [];
const terminalUnavailable = process.platform === 'win32' || !hasScriptCommand();
const TUI_EXIT_MARKER = '__BAZFRAME_TUI_EXIT__=';
const SCENARIO_DEADLINE_MS = 30_000;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('packed-style TUI terminal lifecycle', () => {
  it.skipIf(terminalUnavailable)('enters and restores the alternate screen in a real pseudo-terminal', async () => {
    const fixture = await terminalFixture();

    const result = await runInPseudoTerminal(fixture.environment, [
      { afterOutput: 'Status: Ready', input: 'q' }
    ]);

    expect(result.status, JSON.stringify(result)).toBe(0);
    expect(result.output).toContain('\u001B[?1049h');
    expect(result.output).toContain('[-] Added Skills');
    expect(result.output).not.toContain('Added Skills / Libraries');
    expect(result.output).toContain('\u001B[?1049l');
    expect(result.output).toContain('\u001B[?25h');
    expect(result.stderr).toBe('');

    await rm(fixture.directory.path('home/skills'), { recursive: true });
    await symlink(fixture.directory.path('provider'), fixture.directory.path('home/skills'));
    const errorResult = await runInPseudoTerminal(fixture.environment, [{
      afterOutput: 'Default skill catalog must be a physical directory',
      input: 'q'
    }]);
    expect(errorResult.status, JSON.stringify(errorResult)).toBe(0);
    expect(errorResult.output).toContain('Default skill catalog must be a physical directory');
    expect(errorResult.output).toContain('\u001B[?1049h');
    expect(errorResult.output).toContain('\u001B[?1049l');
    expect(errorResult.output).toContain('\u001B[?25h');

    await rm(fixture.directory.path('home/skills'));
    await fixture.directory.mkdir('home/skills');
    await symlink(await realpath(fixture.directory.path('provider/demo-skill')), fixture.directory.path('home/skills/demo-skill'));
    const screenReaderResult = await runInPseudoTerminal({
      ...fixture.environment,
      INK_SCREEN_READER: 'true'
    }, [
      { afterOutput: 'Status: Ready', input: '\t' },
      { afterOutput: 'Skills tab, selected, focused', input: '\u001B[C' },
      { afterOutput: 'Profiles tab, selected, focused', input: 'q' }
    ]);
    expect(screenReaderResult.status, JSON.stringify(screenReaderResult)).toBe(0);
    expect(screenReaderResult.output).toContain('Profiles tab, selected, focused');
    expect(screenReaderResult.output).toContain('Skills tab, selected, focused');
    expect(screenReaderResult.output).toContain('Profile focused, current, 0 skills');
    expect(screenReaderResult.output).not.toContain('Profile focused, current, active selection');
    expect(screenReaderResult.output).not.toContain('Profile focused, current, parent selection');
    expect(screenReaderResult.output).toContain('Create new profile');
    expect(screenReaderResult.output).toContain('Status: Ready');
    expect(screenReaderResult.output).not.toContain('\u001B[?1049h');
    expect(screenReaderResult.output).not.toContain('\u001B[?1049l');
    for (const eraseSequence of [
      '\u001B[J', '\u001B[0J', '\u001B[1J', '\u001B[2J',
      '\u001B[K', '\u001B[0K', '\u001B[1K', '\u001B[2K'
    ]) {
      expect(screenReaderResult.output).not.toContain(eraseSequence);
    }
    expect(screenReaderResult.output).not.toContain('\u001B[1A');
  });

  it.skipIf(terminalUnavailable)('hands a cooked terminal to the editor and redraws after return', async () => {
    const fixture = await terminalFixture();
    const wrapper = fixture.directory.path('editor-wrapper');
    await fixture.directory.write('editor-wrapper', [
      '#!/bin/sh',
      'case "$(stty -a)" in',
      '  *-icanon*) echo EDITOR-RAW ;;',
      '  *) echo EDITOR-COOKED ;;',
      'esac',
      "printf '\\nedited in pty\\n' >> \"$1\"",
      ''
    ].join('\n'));
    await chmod(wrapper, 0o755);

    const result = await runInPseudoTerminal({ ...fixture.environment, VISUAL: wrapper }, [
      { afterOutput: 'Status: Ready', input: '2' },
      { afterOutput: '+ Create New Profile', input: '\r' },
      { afterOutput: 'Left/h/H/Esc/Backspace', input: 'e' },
      { afterOutput: 'Editor exited successfully', input: 'q' }
    ]);

    expect(result.status, JSON.stringify(result)).toBe(0);
    expect(result.output).toContain('EDITOR-COOKED');
    expect(result.output).not.toContain('EDITOR-RAW');
    expect(result.output.split('\u001B[?1049h').length - 1).toBeGreaterThanOrEqual(2);
    expect(result.output.split('\u001B[?1049l').length - 1).toBeGreaterThanOrEqual(2);
    expect(result.output).toContain('Editor exited successfully');
    expect(result.output).toContain('\u001B[?25h');
    expect(await readFile(fixture.directory.path('home/profiles/focused/AGENTS.md'), 'utf8'))
      .toContain('edited in pty');
    expect(result.stderr).toBe('');
  });

  it.skipIf(terminalUnavailable)('launches a live skill editor from the Skills preview route', async () => {
    const fixture = await terminalFixture();
    const wrapper = fixture.directory.path('skill-editor-wrapper');
    await fixture.directory.write('skill-editor-wrapper', [
      '#!/bin/sh',
      'echo SKILL-EDITOR-COOKED',
      "printf '\nEdited from Skills preview.\n' >> \"$1\"",
      ''
    ].join('\n'));
    await chmod(wrapper, 0o755);

    const result = await runInPseudoTerminal({ ...fixture.environment, VISUAL: wrapper }, [
      { afterOutput: 'Status: Ready', input: '\u001B[B' },
      { afterOutput: 'description: PTY fixture', input: '\r' },
      { afterOutput: 'Left/h back', input: 'e' },
      { afterOutput: 'Editor exited successfully', input: 'q' }
    ]);

    expect(result.status, JSON.stringify(result)).toBe(0);
    expect(result.output).toContain('SKILL-EDITOR-COOKED');
    expect(result.output).toContain('Editor exited successfully');
    expect(result.output.split('\u001B[?1049h').length - 1).toBeGreaterThanOrEqual(2);
    expect(result.output.split('\u001B[?1049l').length - 1).toBeGreaterThanOrEqual(2);
    expect(await readFile(fixture.directory.path('provider/demo-skill/SKILL.md'), 'utf8'))
      .toContain('Edited from Skills preview.');
    expect(result.stderr).toBe('');
  });

  it.skipIf(terminalUnavailable)('keeps the TUI alive when Ctrl+C interrupts the suspended editor', async () => {
    const fixture = await terminalFixture();
    const wrapper = fixture.directory.path('interruptible-editor');
    await fixture.directory.write('interruptible-editor', [
      '#!/bin/sh',
      "trap 'echo EDITOR-INTERRUPTED; exit 130' INT",
      'echo EDITOR-WAITING',
      'while :; do sleep 1; done',
      ''
    ].join('\n'));
    await chmod(wrapper, 0o755);

    const result = await runInPseudoTerminal({ ...fixture.environment, VISUAL: wrapper }, [
      { afterOutput: 'Status: Ready', input: '2' },
      { afterOutput: '+ Create New Profile', input: '\r' },
      { afterOutput: 'Left/h/H/Esc/Backspace', input: 'e' },
      { afterOutput: 'EDITOR-WAITING', input: '\x03' },
      { afterOutput: 'Editor exited with status 130', input: 'q' }
    ]);

    expect(result.status, JSON.stringify(result)).toBe(0);
    expect(result.output).toContain('EDITOR-INTERRUPTED');
    expect(result.output).toContain('Editor exited with status 130');
    expect(result.output.split('\u001B[?1049h').length - 1).toBeGreaterThanOrEqual(2);
    expect(result.output.split('\u001B[?1049l').length - 1).toBeGreaterThanOrEqual(2);
    expect(result.output).toContain('\u001B[?25h');
    expect(result.stderr).toBe('');
  });

  it.skipIf(terminalUnavailable)('handles idle Ctrl+C with exit 130 and complete terminal restoration', async () => {
    const fixture = await terminalFixture();
    const result = await runInPseudoTerminal(fixture.environment, [
      { afterOutput: 'Status: Ready', input: '\x03' }
    ]);

    expect(result.status, JSON.stringify(result)).toBe(130);
    expect(result.output).toContain('\u001B[?1049h');
    expect(result.output).toContain('\u001B[?1049l');
    expect(result.output).toContain('\u001B[?25h');
    expect(result.stderr).toBe('');
  });
});

async function terminalFixture(): Promise<{ environment: NodeJS.ProcessEnv; directory: TempDirectory }> {
  const directory = await createTempDirectory('bazframe tui pty ');
  temporaryDirectories.push(directory);
  await directory.write('home/profiles/focused/AGENTS.md', 'focused\n');
  await directory.mkdir('home/profiles/focused/skills');
  await directory.write('home/active-profile', 'focused\n');
  await directory.write(
    'provider/demo-skill/SKILL.md',
    '---\nname: demo-skill\ndescription: PTY fixture.\n---\n'
  );
  await directory.mkdir('home/skills');
  await symlink(await realpath(directory.path('provider/demo-skill')), directory.path('home/skills/demo-skill'));
  return {
    directory,
    environment: {
      ...process.env,
      BAZFRAME_HOME: directory.path('home'),
      NO_COLOR: '1',
      TERM: 'xterm-256color'
    }
  };
}

function hasScriptCommand(): boolean {
  return spawnSync('sh', ['-c', 'command -v script >/dev/null 2>&1']).status === 0;
}

interface PseudoTerminalInput {
  afterOutput: string;
  input: string;
}

async function runInPseudoTerminal(
  environment: NodeJS.ProcessEnv,
  inputSequence: readonly PseudoTerminalInput[]
): Promise<{
  status: number;
  output: string;
  stderr: string;
}> {
  const deadline = Date.now() + SCENARIO_DEADLINE_MS;
  const command = [
    "trap ':' INT",
    `${shellQuote(process.execPath)} ${shellQuote(cliPath)} tui`,
    'status=$?',
    `printf '\\n${TUI_EXIT_MARKER}%s\\n' "$status"`,
    'exit "$status"'
  ].join('; ');
  const scriptArguments = process.platform === 'darwin'
    ? ['-q', '/dev/null', 'sh', '-c', command]
    : ['-q', '-f', '-e', '-c', `sh -c ${shellQuote(command)}`, '/dev/null'];

  // macOS script(1) rejects Node's socket-backed stdin, so a fixed shell
  // program puts a real pipe in front of it. GNU script accepts Node's pipe.
  const child = process.platform === 'darwin'
    ? spawn('sh', ['-c', 'cat | exec script "$@"', 'sh', ...scriptArguments], {
        cwd: process.cwd(),
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: true
      })
    : spawn('script', scriptArguments, {
        cwd: process.cwd(),
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: true
      });
  const processGroup = child.pid;
  let output = '';
  let stderr = '';
  let nextInput = 0;
  let timedOut = false;

  const sendReadyInput = () => {
    const step = inputSequence[nextInput];
    if (step === undefined || !output.includes(step.afterOutput)) return;
    nextInput += 1;
    if (nextInput === inputSequence.length) child.stdin.end(step.input);
    else child.stdin.write(step.input);
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
    sendReadyInput();
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(processGroup);
  }, Math.max(0, deadline - Date.now()));

  let launchError: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
  } catch (error) {
    launchError = error;
  } finally {
    clearTimeout(timer);
    if (processGroupExists(processGroup)) killProcessGroup(processGroup);
    await waitForProcessGroupGone(processGroup, deadline);
  }

  if (processGroupExists(processGroup)) {
    throw new Error(`TUI PTY process group ${processGroup} survived cleanup.`);
  }
  if (launchError !== undefined) throw launchError;
  if (timedOut) {
    throw new Error(
      `TUI PTY did not exit after input ${nextInput}/${inputSequence.length}. `
      + `Output: ${JSON.stringify(output)}`
    );
  }
  if (nextInput !== inputSequence.length) {
    throw new Error(
      `TUI PTY exited before input ${nextInput + 1}/${inputSequence.length}. `
      + `Output: ${JSON.stringify(output)}`
    );
  }
  const statuses = [...output.matchAll(new RegExp(`${TUI_EXIT_MARKER}(\\d+)`, 'gu'))];
  const status = statuses.at(-1)?.[1];
  if (status === undefined) throw new Error(`TUI PTY omitted its exit marker. Output: ${JSON.stringify(output)}`);
  return { status: Number(status), output, stderr };
}

function processGroupExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function waitForProcessGroupGone(pid: number | undefined, deadline: number): Promise<void> {
  while (processGroupExists(pid) && Date.now() < deadline) {
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

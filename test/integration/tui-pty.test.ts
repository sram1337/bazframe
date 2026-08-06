import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe('packed-style TUI terminal lifecycle', () => {
  it('enters and restores the alternate screen in a real pseudo-terminal', async () => {
    if (process.platform === 'win32' || !hasScriptCommand()) return;
    const directory = await createTempDirectory('bazframe tui pty ');
    temporaryDirectories.push(directory);
    const home = directory.path('home');
    const library = directory.path('library');
    await directory.write('home/profiles/focused/AGENTS.md', 'focused\n');
    await directory.mkdir('home/profiles/focused/skills');
    await directory.write('home/active-profile', 'focused\n');
    await directory.write(
      'library/skills/demo-skill/SKILL.md',
      '---\nname: demo-skill\ndescription: PTY fixture.\n---\n'
    );

    const result = await runInPseudoTerminal({
      ...process.env,
      BAZFRAME_HOME: home,
      SKILLBOOK_LIBRARY: library,
      NO_COLOR: '1'
    }, [{ afterOutput: 'Status: Ready', input: 'q' }]);

    expect(result.status, JSON.stringify(result)).toBe(0);
    expect(result.output).toContain('\u001B[?1049h');
    expect(result.output).toContain('focused');
    expect(result.output).toContain('\u001B[?1049l');
    expect(result.stderr).toBe('');

    const errorResult = await runInPseudoTerminal({
      ...process.env,
      BAZFRAME_HOME: home,
      SKILLBOOK_LIBRARY: 'relative-library',
      NO_COLOR: '1'
    }, [{
      afterOutput: 'SKILLBOOK_LIBRARY must be an absolute path',
      input: 'q'
    }]);
    expect(errorResult.status, JSON.stringify(errorResult)).toBe(0);
    expect(errorResult.output).toContain('SKILLBOOK_LIBRARY must be an absolute path');
    expect(errorResult.output).toContain('\u001B[?1049h');
    expect(errorResult.output).toContain('\u001B[?1049l');

    const screenReaderResult = await runInPseudoTerminal({
      ...process.env,
      BAZFRAME_HOME: home,
      SKILLBOOK_LIBRARY: library,
      NO_COLOR: '1',
      INK_SCREEN_READER: 'true'
    }, [
      { afterOutput: 'Status: Ready', input: '\t' },
      { afterOutput: 'Profiles tab, selected, focused', input: '\u001B[C' },
      { afterOutput: 'Skills tab, focused', input: 'q' }
    ]);
    expect(screenReaderResult.status, JSON.stringify(screenReaderResult)).toBe(0);
    expect(screenReaderResult.output).toContain('Profiles tab, selected, focused');
    expect(screenReaderResult.output).toContain('Skills tab, focused');
    expect(screenReaderResult.output).not.toContain('Skills tab, selected');
    expect(screenReaderResult.output).toContain('Profile focused, active, selected');
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
});

function hasScriptCommand(): boolean {
  return spawnSync('sh', ['-c', 'command -v script >/dev/null 2>&1']).status === 0;
}

interface PseudoTerminalInput {
  afterOutput: string;
  input: string;
}

function runInPseudoTerminal(
  environment: NodeJS.ProcessEnv,
  inputSequence: readonly PseudoTerminalInput[]
): Promise<{
  status: number | null;
  output: string;
  stderr: string;
}> {
  const scriptArguments = process.platform === 'darwin'
    ? ['-q', '/dev/null', process.execPath, cliPath, 'tui']
    : [
        '-q',
        '-e',
        '-c',
        `${shellQuote(process.execPath)} ${shellQuote(cliPath)} tui`,
        '/dev/null'
      ];

  return new Promise((resolve, reject) => {
    // macOS script(1) rejects Node's socket-backed stdin. A fixed shell program
    // puts a real pipe in front of it; arguments stay out of shell source.
    const child = spawn('sh', ['-c', 'cat | exec script "$@"', 'sh', ...scriptArguments], {
      cwd: process.cwd(),
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true
    });
    let output = '';
    let stderr = '';
    let nextInput = 0;
    const timer = setTimeout(() => {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      reject(new Error(
        `TUI PTY did not exit after input ${nextInput}/${inputSequence.length}. `
        + `Output: ${JSON.stringify(output)}`
      ));
    }, 8_000);

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
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      if (nextInput !== inputSequence.length) {
        reject(new Error(
          `TUI PTY exited before input ${nextInput + 1}/${inputSequence.length}. `
          + `Output: ${JSON.stringify(output)}`
        ));
        return;
      }
      resolve({ status, output, stderr });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

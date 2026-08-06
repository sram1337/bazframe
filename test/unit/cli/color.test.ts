import { describe, expect, it } from 'vitest';
import {
  colorizeHelp,
  createCliColors,
  shouldUseColor
} from '../../../src/cli/color.js';
import { runCli } from '../../../src/cli/run-cli.js';

describe('CLI color', () => {
  it('uses color for terminals and FORCE_COLOR but honors NO_COLOR', () => {
    expect(shouldUseColor({}, true)).toBe(true);
    expect(shouldUseColor({}, false)).toBe(false);
    expect(shouldUseColor({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(shouldUseColor({ FORCE_COLOR: '0' }, true)).toBe(false);
    expect(shouldUseColor({ FORCE_COLOR: '1', NO_COLOR: '' }, true)).toBe(false);
  });

  it('styles headings only when color is enabled', () => {
    const help = 'Bazframe 2\n\nUsage: bazframe <resource>\n\nResources:\n';
    const colored = colorizeHelp(help, createCliColors(true));
    expect(colored).toContain('\u001b[1;36mBazframe 2\u001b[0m');
    expect(colored).toContain('\u001b[1;36mUsage:\u001b[0m');
    expect(colorizeHelp(help, createCliColors(false))).toBe(help);
  });

  it('colors terminal help and errors without contaminating nonterminal output', async () => {
    let stdout = '';
    let stderr = '';
    await runCli(['--help'], {
      environment: {},
      stdoutIsTty: true,
      writeStdout: (text) => { stdout += text; },
      writeStderr: (text) => { stderr += text; }
    });
    expect(stdout).toContain('\u001b[');
    expect(stderr).toBe('');

    stdout = '';
    stderr = '';
    await runCli(['unknown'], {
      environment: { NO_COLOR: '' },
      stderrIsTty: true,
      writeStdout: (text) => { stdout += text; },
      writeStderr: (text) => { stderr += text; }
    });
    expect(stdout).toBe('');
    expect(stderr).toContain('error: Unknown command');
    expect(stderr).not.toContain('\u001b[');
  });
});

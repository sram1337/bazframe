import { describe, expect, it } from 'vitest';
import { parseArgv } from '../../../src/cli/parse-argv.js';

const forbidden = [
  '-c', '-r', '--continue', '--resume', '--session', '--session-id', '--fork',
  '--session=abc', '--session-id=abc', '--fork=abc'
];

describe('parseArgv', () => {
  it('parses help, version, and use', () => {
    expect(parseArgv([])).toEqual({ kind: 'help', topic: 'root' });
    expect(parseArgv(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgv(['use', 'focused'])).toEqual({
      kind: 'command',
      command: { name: 'use', profileId: 'focused' }
    });
    expect(parseArgv(['pi', '--help'])).toEqual({ kind: 'help', topic: 'pi' });
  });

  it('parses dry-run and strips only the wrapper delimiter', () => {
    expect(parseArgv(['pi', '--dry-run', '--', '-p', 'hello world', '--model', 'x/y']))
      .toEqual({
        kind: 'command',
        command: {
          name: 'pi',
          dryRun: true,
          forwardedArgs: ['-p', 'hello world', '--model', 'x/y']
        }
      });
    expect(parseArgv(['pi', '--'])).toEqual({
      kind: 'command',
      command: { name: 'pi', dryRun: false, forwardedArgs: [] }
    });
  });

  it('rejects malformed wrapper arguments', () => {
    expect(parseArgv(['use'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['use', 'a', 'b'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['pi', '-p', 'hello'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['pi', '--dry-run', '--dry-run'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['wat'])).toMatchObject({ kind: 'usage-error' });
  });

  it.each(forbidden)('rejects repository-switching Pi option %s', (argument) => {
    const result = parseArgv(['pi', '--', argument]);
    expect(result).toMatchObject({ kind: 'usage-error' });
    if (result.kind === 'usage-error') expect(result.message).toContain('session-switching');
  });

  it.each([
    ['--mode', 'rpc'],
    ['--mode=rpc']
  ])('rejects repository-switching Pi RPC mode %j', (...forwarded) => {
    const result = parseArgv(['pi', '--', ...forwarded]);
    expect(result).toMatchObject({ kind: 'usage-error' });
    if (result.kind === 'usage-error') expect(result.message).toContain('RPC');
  });

  it('forwards all other post-delimiter arguments unchanged', () => {
    const forwarded = [
      '--no-skills', '--mode', 'json', '--append-system-prompt', 'more', '@a file.md', '--', 'text'
    ];
    const result = parseArgv(['pi', '--', ...forwarded]);
    expect(result).toEqual({
      kind: 'command',
      command: { name: 'pi', dryRun: false, forwardedArgs: forwarded }
    });
  });
});

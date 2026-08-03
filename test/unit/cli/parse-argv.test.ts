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
    expect(parseArgv(['adapter', '--help'])).toEqual({ kind: 'help', topic: 'adapter' });
    expect(parseArgv(['init', '--help'])).toEqual({ kind: 'help', topic: 'init' });
    expect(parseArgv(['status', '--help'])).toEqual({ kind: 'help', topic: 'status' });
  });

  it('parses repository and status commands', () => {
    expect(parseArgv(['init'])).toEqual({ kind: 'command', command: { name: 'init' } });
    expect(parseArgv(['uninit'])).toEqual({ kind: 'command', command: { name: 'uninit' } });
    expect(parseArgv(['status'])).toEqual({ kind: 'command', command: { name: 'status' } });
    expect(parseArgv(['init', 'extra'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['uninit', 'extra'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['status', 'extra'])).toMatchObject({ kind: 'usage-error' });
  });

  it('parses Pi adapter lifecycle commands', () => {
    expect(parseArgv(['adapter', 'install', 'pi'])).toEqual({
      kind: 'command',
      command: { name: 'adapter-install-pi', force: false }
    });
    expect(parseArgv(['adapter', 'install', 'pi', '--force'])).toEqual({
      kind: 'command',
      command: { name: 'adapter-install-pi', force: true }
    });
    expect(parseArgv(['adapter', 'uninstall', 'pi'])).toEqual({
      kind: 'command',
      command: { name: 'adapter-uninstall-pi' }
    });
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
    expect(parseArgv(['adapter'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['adapter', 'install', 'pi', '--other']))
      .toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['adapter', 'uninstall', 'pi', '--force']))
      .toMatchObject({ kind: 'usage-error' });
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

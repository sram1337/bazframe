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
    expect(parseArgv(['add', 'skill', '/absolute/review-skill'])).toEqual({
      kind: 'command', command: { name: 'default-skill-add', skillRoot: '/absolute/review-skill' }
    });
    expect(parseArgv(['remove', 'skill', 'review-skill'])).toEqual({
      kind: 'command', command: { name: 'default-skill-remove', skillId: 'review-skill' }
    });
    expect(parseArgv(['add', 'skill', '--help'])).toEqual({ kind: 'help', topic: 'add-skill' });
    expect(parseArgv(['remove', 'skill', '--help'])).toEqual({ kind: 'help', topic: 'remove-skill' });
    expect(parseArgv(['add', '--help'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['remove', '--help'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['help', 'add', 'skill'])).toEqual({ kind: 'help', topic: 'add-skill' });
    expect(parseArgv(['pi', '--help'])).toEqual({ kind: 'help', topic: 'pi' });
    expect(parseArgv(['adapter', '--help'])).toEqual({ kind: 'help', topic: 'adapter' });
    expect(parseArgv(['global', '--help'])).toEqual({ kind: 'help', topic: 'global' });
    expect(parseArgv(['init', '--help'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['status', '--help'])).toEqual({ kind: 'help', topic: 'status' });
    expect(parseArgv(['help', 'profiles'])).toEqual({ kind: 'help', topic: 'profile' });
    expect(parseArgv(['help', 'profile', 'skills'])).toEqual({
      kind: 'help', topic: 'profile-skills'
    });
  });

  it('parses the profile lifecycle namespace and help', () => {
    expect(parseArgv(['profile'])).toEqual({
      kind: 'command', command: { name: 'profiles-overview' }
    });
    expect(parseArgv(['profiles'])).toEqual({
      kind: 'command', command: { name: 'profiles-overview' }
    });
    expect(parseArgv(['profile', '--help'])).toEqual({ kind: 'help', topic: 'profile' });
    expect(parseArgv(['profile', 'add', 'focused'])).toEqual({
      kind: 'command', command: { name: 'profile-add', profileId: 'focused' }
    });
    expect(parseArgv(['profile', 'duplicate', 'focused', 'reviewer'])).toEqual({
      kind: 'command',
      command: { name: 'profile-duplicate', sourceProfileId: 'focused', profileId: 'reviewer' }
    });
    expect(parseArgv(['profile', 'remove', 'focused'])).toEqual({
      kind: 'command', command: { name: 'profile-remove', profileId: 'focused', force: false }
    });
    expect(parseArgv(['profile', 'remove', 'focused', '--force'])).toEqual({
      kind: 'command', command: { name: 'profile-remove', profileId: 'focused', force: true }
    });
    expect(parseArgv(['profile', 'rename', 'focused', 'reviewer'])).toEqual({
      kind: 'command',
      command: { name: 'profile-rename', previousProfileId: 'focused', profileId: 'reviewer' }
    });
    expect(parseArgv(['profile', 'use', 'focused'])).toEqual({
      kind: 'command', command: { name: 'profile-use', profileId: 'focused' }
    });
    expect(parseArgv(['profile', 'list'])).toEqual({
      kind: 'command', command: { name: 'profile-list' }
    });
    expect(parseArgv(['profile', 'current'])).toEqual({
      kind: 'command', command: { name: 'profile-current' }
    });
    expect(parseArgv(['profile', 'skills'])).toEqual({
      kind: 'command', command: { name: 'profile-skills-overview' }
    });
    expect(parseArgv(['profile', 'skills', 'add', 'review-skill'])).toEqual({
      kind: 'command', command: { name: 'profile-skill-add', skillId: 'review-skill' }
    });
    expect(parseArgv(['profile', 'skills', 'remove', 'review-skill'])).toEqual({
      kind: 'command', command: { name: 'profile-skill-remove', skillId: 'review-skill' }
    });
    expect(parseArgv([
      'profile', 'skills', 'add', 'review-skill', '--profile', 'reviewer'
    ])).toEqual({
      kind: 'command',
      command: { name: 'profile-skill-add', skillId: 'review-skill', profileId: 'reviewer' }
    });
    expect(parseArgv([
      'profile', 'skills', 'remove', 'review-skill', '--profile', 'reviewer'
    ])).toEqual({
      kind: 'command',
      command: { name: 'profile-skill-remove', skillId: 'review-skill', profileId: 'reviewer' }
    });
    expect(parseArgv(['profile', 'skills', '--help'])).toEqual({
      kind: 'help', topic: 'profile-skills'
    });
    for (const topic of ['add', 'duplicate', 'remove', 'rename', 'use', 'list', 'current']) {
      expect(parseArgv(['profile', topic, '--help'])).toEqual({
        kind: 'help', topic: `profile-${topic}`
      });
    }
  });

  it('parses only global source lifecycle and profile reference grammar', () => {
    expect(parseArgv(['sources'])).toEqual({ kind: 'command', command: { name: 'sources-overview' } });
    expect(parseArgv(['sources', 'add', '/absolute/root'])).toEqual({
      kind: 'command', command: { name: 'sources-add', sourceRoot: '/absolute/root' }
    });
    expect(parseArgv(['sources', 'build', 'source'])).toEqual({ kind: 'command', command: { name: 'sources-build', sourceId: 'source' } });
    expect(parseArgv(['sources', 'remove', 'source'])).toEqual({ kind: 'command', command: { name: 'sources-remove', sourceId: 'source' } });
    expect(parseArgv(['profile', 'sources'])).toEqual({ kind: 'command', command: { name: 'profile-sources-overview' } });
    expect(parseArgv(['profile', 'sources', 'add', 'source'])).toEqual({ kind: 'command', command: { name: 'profile-sources-add', sourceId: 'source' } });
    expect(parseArgv(['profile', 'sources', 'add', 'source', '--profile', 'reviewer'])).toEqual({ kind: 'command', command: { name: 'profile-sources-add', sourceId: 'source', profileId: 'reviewer' } });
    expect(parseArgv(['profile', 'sources', 'remove', 'source'])).toEqual({ kind: 'command', command: { name: 'profile-sources-remove', sourceId: 'source' } });
    expect(parseArgv(['help', 'sources', 'build'])).toEqual({ kind: 'help', topic: 'sources-build' });
    for (const argv of [
      ['source'],
      ['profile', 'sources', 'build', 'source'],
      ['sources', 'add', 'provider', '/root'],
      ['sources', 'add', 'provider', 'source', '/root'],
      ['sources', 'build', 'provider', 'source'],
      ['sources', 'remove', 'provider', 'source'],
      ['profile', 'sources', 'add', 'provider', 'source'],
      ['profile', 'sources', 'add', 'provider', 'source', '--profile', 'reviewer'],
      ['profile', 'sources', 'remove', 'provider', 'source'],
      ['profile', 'sources', 'remove', 'provider', 'source', '--profile', 'reviewer'],
      ['sources', 'add', 'relative'],
      ['sources', 'remove', 'Bad'],
      ['profile', 'sources', 'remove', 'source', '--profile'],
      ['profile', 'sources', 'remove', 'source', '--profile', 'Bad']
    ]) expect(parseArgv(argv)).toMatchObject({ kind: 'usage-error' });
  });

  it('rejects malformed profile lifecycle arguments without changing skill commands', () => {
    for (const argv of [
      ['profile', 'wat'],
      ['profile', 'add'],
      ['profile', 'add', '../bad'],
      ['profile', 'duplicate'],
      ['profile', 'duplicate', 'focused'],
      ['profile', 'duplicate', 'focused', 'reviewer', 'extra'],
      ['profile', 'duplicate', '../bad', 'reviewer'],
      ['profile', 'duplicate', 'focused', 'Bad'],
      ['profile', 'remove', '--force', 'focused'],
      ['profile', 'remove', 'focused', '--other'],
      ['profile', 'rename', 'focused'],
      ['profile', 'rename', 'focused', 'Bad'],
      ['profile', 'list', 'extra'],
      ['profile', 'current', 'extra']
    ]) {
      expect(parseArgv(argv)).toMatchObject({ kind: 'usage-error' });
    }
    expect(parseArgv(['add', 'review-skill'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['remove', 'review-skill'])).toMatchObject({ kind: 'usage-error' });
  });

  it('parses resource overviews, repository commands, and status', () => {
    expect(parseArgv(['skills'])).toEqual({
      kind: 'command', command: { name: 'skills-overview' }
    });
    expect(parseArgv(['skill'])).toEqual({
      kind: 'command', command: { name: 'skills-overview' }
    });
    expect(parseArgv(['project'])).toEqual({
      kind: 'command', command: { name: 'projects-overview' }
    });
    expect(parseArgv(['projects'])).toEqual({
      kind: 'command', command: { name: 'projects-overview' }
    });
    expect(parseArgv(['adapter'])).toEqual({
      kind: 'command', command: { name: 'adapters-overview' }
    });
    expect(parseArgv(['adapters'])).toEqual({
      kind: 'command', command: { name: 'adapters-overview' }
    });
    expect(parseArgv(['global'])).toEqual({
      kind: 'command', command: { name: 'global-overview' }
    });
    expect(parseArgv(['global', 'enable'])).toEqual({
      kind: 'command', command: { name: 'global-enable' }
    });
    expect(parseArgv(['global', 'disable'])).toEqual({
      kind: 'command', command: { name: 'global-disable' }
    });
    expect(parseArgv(['project', 'enable'])).toEqual({
      kind: 'command', command: { name: 'project-enable' }
    });
    expect(parseArgv(['project', 'disable'])).toEqual({
      kind: 'command', command: { name: 'project-disable' }
    });
    for (const argv of [
      ['init'], ['uninit'], ['project', 'init'], ['project', 'uninit']
    ]) {
      const result = parseArgv(argv);
      expect(result).toMatchObject({ kind: 'usage-error' });
      if (result.kind === 'usage-error') expect(result.message).toContain('bazframe project');
    }
    expect(parseArgv(['status'])).toEqual({ kind: 'command', command: { name: 'status' } });
    expect(parseArgv(['tui'])).toEqual({ kind: 'command', command: { name: 'tui' } });
    expect(parseArgv(['tui', '--help'])).toEqual({ kind: 'help', topic: 'tui' });
    expect(parseArgv(['help', 'tui'])).toEqual({ kind: 'help', topic: 'tui' });
    expect(parseArgv(['global', 'enable', 'extra'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['project', 'disable', 'extra'])).toMatchObject({ kind: 'usage-error' });
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
    expect(parseArgv(['add'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['remove', 'a', 'b'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['add', '../escape'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['remove', '--force'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['pi', '-p', 'hello'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['pi', '--dry-run', '--dry-run'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['wat'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['profiles', 'add', 'focused'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['skills', 'extra'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgv(['profile', 'skills', 'wat'])).toMatchObject({ kind: 'usage-error' });
    for (const argv of [
      ['profile', 'skills', 'add', 'review-skill', '--profile'],
      ['profile', 'skills', 'add', 'review-skill', '--profile', 'Bad'],
      ['profile', 'skills', 'add', '--profile', 'reviewer', 'review-skill'],
      ['profile', 'skills', 'remove', 'review-skill', '--other', 'reviewer'],
      ['add', 'review-skill', '--profile', 'reviewer'],
      ['remove', 'review-skill', '--profile', 'reviewer'],
      ['add', 'skills', '/absolute/root'],
      ['add', 'skill'],
      ['add', 'skill', 'relative'],
      ['add', 'skill', '/absolute/root', 'extra'],
      ['remove', 'skills', 'review-skill'],
      ['remove', 'skill'],
      ['remove', 'skill', 'Bad'],
      ['skill', 'add', '/absolute/root'],
      ['skills', 'add', '/absolute/root'],
      ['tui', 'extra']
    ]) {
      expect(parseArgv(argv)).toMatchObject({ kind: 'usage-error' });
    }
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

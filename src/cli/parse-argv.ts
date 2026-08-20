import { assertSafeForwardedPiArgs } from '../agents/pi-args.js';
import { isAbsolute } from 'node:path';
import { BazframeError } from '../core/errors.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { isSafeSkillId } from '../skills/skill-id.js';

export type HelpTopic =
  | 'root' | 'use' | 'add-skill' | 'remove-skill' | 'pi' | 'adapter' | 'status' | 'global'
  | 'profile' | 'profile-add' | 'profile-duplicate' | 'profile-remove' | 'profile-rename'
  | 'profile-use' | 'profile-edit' | 'profile-list' | 'profile-current' | 'profile-skills'
  | 'profile-skills-add' | 'profile-skills-remove' | 'profile-libraries' | 'profile-libraries-add' | 'profile-libraries-remove'
  | 'profile-packages' | 'profile-packages-add' | 'profile-packages-remove'
  | 'libraries' | 'libraries-add' | 'libraries-update' | 'libraries-remove'
  | 'packages' | 'packages-add' | 'packages-build' | 'packages-remove'
  | 'skills' | 'skill-edit' | 'project' | 'tui';
export type Command =
  | { name: 'profiles-overview' }
  | { name: 'skills-overview' }
  | { name: 'profile-skills-overview' }
  | { name: 'libraries-overview' }
  | { name: 'libraries-add'; root: string }
  | { name: 'libraries-update'; id: string }
  | { name: 'libraries-remove'; id: string }
  | { name: 'packages-overview' }
  | { name: 'packages-add'; root: string }
  | { name: 'packages-build'; id: string }
  | { name: 'packages-remove'; id: string }
  | { name: 'profile-libraries-overview' }
  | { name: 'profile-libraries-add'; id: string; profileId?: string }
  | { name: 'profile-libraries-remove'; id: string; profileId?: string }
  | { name: 'profile-packages-overview' }
  | { name: 'profile-packages-add'; id: string; profileId?: string }
  | { name: 'profile-packages-remove'; id: string; profileId?: string }
  | { name: 'projects-overview' }
  | { name: 'global-overview' }
  | { name: 'adapters-overview' }
  | { name: 'use'; profileId: string }
  | { name: 'default-skill-add'; skillRoot: string }
  | { name: 'default-skill-remove'; skillId: string }
  | { name: 'skill-edit'; skillId: string }
  | { name: 'profile-skill-add'; skillId: string; profileId?: string }
  | { name: 'profile-skill-remove'; skillId: string; profileId?: string }
  | { name: 'profile-add'; profileId: string }
  | { name: 'profile-duplicate'; sourceProfileId: string; profileId: string }
  | { name: 'profile-remove'; profileId: string; force: boolean }
  | { name: 'profile-rename'; previousProfileId: string; profileId: string }
  | { name: 'profile-use'; profileId: string }
  | { name: 'profile-edit'; profileId: string }
  | { name: 'profile-list' }
  | { name: 'profile-current' }
  | { name: 'pi'; dryRun: boolean; forwardedArgs: string[] }
  | { name: 'adapter-install-pi'; force: boolean }
  | { name: 'adapter-uninstall-pi' }
  | { name: 'global-enable' }
  | { name: 'global-disable' }
  | { name: 'project-enable' }
  | { name: 'project-disable' }
  | { name: 'status' }
  | { name: 'tui' };
export type ParseResult =
  | { kind: 'help'; topic: HelpTopic }
  | { kind: 'version' }
  | { kind: 'command'; command: Command }
  | { kind: 'usage-error'; message: string; topic: HelpTopic };

const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-v', '--version']);

export function parseArgv(argv: readonly string[]): ParseResult {
  if (argv.length === 0) return { kind: 'help', topic: 'root' };

  const [first, ...rest] = argv;
  if (first === 'help') return parseHelp(rest);
  if (HELP_FLAGS.has(first)) {
    return rest.length === 0
      ? { kind: 'help', topic: 'root' }
      : usageError('Help flags do not accept additional arguments.', 'root');
  }
  if (VERSION_FLAGS.has(first)) {
    return rest.length === 0
      ? { kind: 'version' }
      : usageError('Version flags do not accept additional arguments.', 'root');
  }
  if (first === 'profile') return parseProfile(rest);
  if (first === 'profiles') return parsePluralOverview(rest, 'profiles-overview', 'profile');
  if (first === 'skill') return parseSkill(rest);
  if (first === 'skills') return parsePluralOverview(rest, 'skills-overview', 'skills', 'skill');
  if (first === 'libraries') return parseCollections('library', rest);
  if (first === 'packages') return parseCollections('package', rest);
  if (first === 'project') return parseProject(rest);
  if (first === 'projects') return parsePluralOverview(rest, 'projects-overview', 'project');
  if (first === 'global') return parseGlobal(rest);
  if (first === 'adapter') return parseAdapter(rest);
  if (first === 'adapters') return parsePluralOverview(rest, 'adapters-overview', 'adapter');
  if (first === 'use') return parseUse(rest);
  if (first === 'add' || first === 'remove') return parseDefaultSkillLifecycle(first, rest);
  if (first === 'pi') return parsePi(rest);
  if (first === 'tui') return parseNoArgumentCommand('tui', rest, 'tui');
  if (first === 'init' || first === 'uninit') {
    return migrationError(first);
  }
  if (first === 'status') return parseNoArgumentCommand('status', rest, 'status');
  return usageError(`Unknown command: ${first}`, 'root');
}

function parseHelp(args: readonly string[]): ParseResult {
  if (args.length === 0) return { kind: 'help', topic: 'root' };
  const key = args.join(' ');
  const topic = new Map<string, HelpTopic>([
    ['profile', 'profile'], ['profiles', 'profile'],
    ['profile edit', 'profile-edit'],
    ['profile skills', 'profile-skills'],
    ['profile libraries', 'profile-libraries'], ['profile libraries add', 'profile-libraries-add'], ['profile libraries remove', 'profile-libraries-remove'],
    ['profile packages', 'profile-packages'], ['profile packages add', 'profile-packages-add'], ['profile packages remove', 'profile-packages-remove'],
    ['libraries', 'libraries'], ['libraries add', 'libraries-add'], ['libraries update', 'libraries-update'], ['libraries remove', 'libraries-remove'],
    ['packages', 'packages'], ['packages add', 'packages-add'], ['packages build', 'packages-build'], ['packages remove', 'packages-remove'],
    ['skill', 'skills'], ['skills', 'skills'], ['skill edit', 'skill-edit'],
    ['project', 'project'], ['projects', 'project'],
    ['global', 'global'],
    ['adapter', 'adapter'], ['adapters', 'adapter'],
    ['status', 'status'], ['tui', 'tui'],
    ['use', 'use'], ['add skill', 'add-skill'], ['remove skill', 'remove-skill'], ['pi', 'pi']
  ]).get(key);
  if (key === 'init' || key === 'uninit') return migrationError(key);
  return topic === undefined
    ? usageError(`Unknown help topic: ${key}`, 'root')
    : { kind: 'help', topic };
}

function parsePluralOverview(
  args: readonly string[],
  command: Command['name'],
  topic: HelpTopic,
  singularResource: string = topic
): ParseResult {
  if (args.length === 0) {
    return { kind: 'command', command: { name: command } as Command };
  }
  if (args.length === 1 && HELP_FLAGS.has(args[0])) return { kind: 'help', topic };
  return usageError(`Use the singular ${JSON.stringify(singularResource)} resource for commands.`, topic);
}

function parseSkill(args: readonly string[]): ParseResult {
  if (args.length === 0) return { kind: 'command', command: { name: 'skills-overview' } };
  if (args.length === 1 && HELP_FLAGS.has(args[0])) return { kind: 'help', topic: 'skills' };
  const [subcommand, ...rest] = args;
  if (subcommand !== 'edit') {
    return usageError('skill requires `edit`.', 'skills');
  }
  if (rest.length === 1 && HELP_FLAGS.has(rest[0])) return { kind: 'help', topic: 'skill-edit' };
  if (rest.length !== 1) {
    return usageError('skill edit requires exactly one <skill> argument.', 'skill-edit');
  }
  if (!isSafeSkillId(rest[0])) return invalidSkillId('skill-edit');
  return { kind: 'command', command: { name: 'skill-edit', skillId: rest[0] } };
}

function parseUse(args: readonly string[]): ParseResult {
  if (args.length === 1 && HELP_FLAGS.has(args[0])) {
    return { kind: 'help', topic: 'use' };
  }
  if (args.length !== 1) {
    return usageError('use requires exactly one <profile> argument.', 'use');
  }
  const profileId = args[0];
  if (!isSafeProfileId(profileId)) return invalidProfileId('use');
  return { kind: 'command', command: { name: 'use', profileId } };
}

function parseProfile(args: readonly string[]): ParseResult {
  if (args.length === 0) {
    return { kind: 'command', command: { name: 'profiles-overview' } };
  }
  if (args.length === 1 && HELP_FLAGS.has(args[0])) {
    return { kind: 'help', topic: 'profile' };
  }
  const [subcommand, ...rest] = args;
  if (subcommand === 'skills') return parseProfileSkills(rest);
  if (subcommand === 'libraries') return parseProfileCollections('library', rest);
  if (subcommand === 'packages') return parseProfileCollections('package', rest);
  if (!new Set(['add', 'duplicate', 'remove', 'rename', 'use', 'edit', 'list', 'current']).has(subcommand)) {
    return usageError(
      'profile requires `skills`, `libraries`, `packages`, `add`, `duplicate`, `remove`, `rename`, `use`, `edit`, `list`, or `current`.',
      'profile'
    );
  }
  const topic = `profile-${subcommand}` as HelpTopic;
  if (rest.length === 1 && HELP_FLAGS.has(rest[0])) {
    return { kind: 'help', topic };
  }
  if (subcommand === 'list' || subcommand === 'current') {
    return rest.length === 0
      ? { kind: 'command', command: { name: `profile-${subcommand}` } as Command }
      : usageError(`profile ${subcommand} accepts no arguments.`, topic);
  }
  if (subcommand === 'rename' || subcommand === 'duplicate') {
    if (rest.length !== 2) {
      const argumentsDescription = subcommand === 'rename' ? '<old> and <new>' : '<source> and <new>';
      return usageError(
        `profile ${subcommand} requires exactly ${argumentsDescription} profile IDs.`,
        topic
      );
    }
    if (!isSafeProfileId(rest[0]) || !isSafeProfileId(rest[1])) {
      return invalidProfileId(topic);
    }
    return {
      kind: 'command',
      command: subcommand === 'rename'
        ? {
            name: 'profile-rename',
            previousProfileId: rest[0],
            profileId: rest[1]
          }
        : {
            name: 'profile-duplicate',
            sourceProfileId: rest[0],
            profileId: rest[1]
          }
    };
  }
  if (subcommand === 'remove') {
    const force = rest.length === 2 && rest[1] === '--force';
    if (!(rest.length === 1 || force)) {
      return usageError(
        'profile remove requires <profile> followed only by optional --force.',
        topic
      );
    }
    if (!isSafeProfileId(rest[0])) return invalidProfileId(topic);
    return { kind: 'command', command: { name: 'profile-remove', profileId: rest[0], force } };
  }
  if (rest.length !== 1) {
    return usageError(`profile ${subcommand} requires exactly one <profile> argument.`, topic);
  }
  if (!isSafeProfileId(rest[0])) return invalidProfileId(topic);
  return {
    kind: 'command',
    command: { name: `profile-${subcommand}`, profileId: rest[0] } as Command
  };
}

function parseProfileSkills(args: readonly string[]): ParseResult {
  if (args.length === 0) {
    return { kind: 'command', command: { name: 'profile-skills-overview' } };
  }
  if (args.length === 1 && HELP_FLAGS.has(args[0])) {
    return { kind: 'help', topic: 'profile-skills' };
  }
  const [subcommand, ...rest] = args;
  if (subcommand !== 'add' && subcommand !== 'remove') {
    return usageError('profile skills requires `add` or `remove`.', 'profile-skills');
  }
  return parseMembership(subcommand, rest, `profile-skills-${subcommand}`);
}

function parseProfileCollections(kind: 'library' | 'package', args: readonly string[]): ParseResult {
  const plural = kind === 'library' ? 'libraries' : 'packages';
  const overview = `profile-${plural}-overview` as Command['name'];
  const help = `profile-${plural}` as HelpTopic;
  if (args.length === 0) return { kind: 'command', command: { name: overview } as Command };
  if (args.length === 1 && HELP_FLAGS.has(args[0])) return { kind: 'help', topic: help };
  const [subcommand, ...rest] = args;
  if (subcommand !== 'add' && subcommand !== 'remove') return usageError(`profile ${plural} requires \`add\` or \`remove\`.`, help);
  const topic = `profile-${plural}-${subcommand}` as HelpTopic;
  if (rest.length === 1 && HELP_FLAGS.has(rest[0])) return { kind: 'help', topic };
  const hasExplicitProfile = rest.length === 3 && rest[1] === '--profile';
  if (!(rest.length === 1 || hasExplicitProfile)) return usageError(`profile ${plural} ${subcommand} requires <${kind}> followed only by optional --profile <profile>.`, topic);
  if (!isSafeSkillId(rest[0])) return invalidCollectionId(kind, topic);
  const profileId = hasExplicitProfile ? rest[2] : undefined;
  if (profileId !== undefined && !isSafeProfileId(profileId)) return invalidProfileId(topic);
  return { kind: 'command', command: { name: `profile-${plural}-${subcommand}`, id: rest[0], ...(profileId === undefined ? {} : { profileId }) } as Command };
}

function parseCollections(kind: 'library' | 'package', args: readonly string[]): ParseResult {
  const plural = kind === 'library' ? 'libraries' : 'packages';
  if (args.length === 0) return { kind: 'command', command: { name: `${plural}-overview` } as Command };
  if (args.length === 1 && HELP_FLAGS.has(args[0])) return { kind: 'help', topic: plural };
  const [subcommand, ...rest] = args;
  const allowed = kind === 'library' ? new Set(['add', 'update', 'remove']) : new Set(['add', 'build', 'remove']);
  if (!allowed.has(subcommand)) return usageError(`${plural} requires ${kind === 'library' ? '`add`, `update`, or `remove`' : '`add`, `build`, or `remove`'}.`, plural);
  const topic = `${plural}-${subcommand}` as HelpTopic;
  if (rest.length === 1 && HELP_FLAGS.has(rest[0])) return { kind: 'help', topic };
  if (rest.length !== 1) return usageError(`${plural} ${subcommand} requires ${subcommand === 'add' ? '<absolute-root>' : `<${kind}>`}.`, topic);
  if (subcommand === 'add') {
    const root = rest[0];
    if (!isAbsolute(root) || root.includes('\0')) return usageError(`${kind === 'library' ? 'Library' : 'Package'} root must be a non-empty absolute path without NUL bytes.`, topic);
    return { kind: 'command', command: { name: `${plural}-add`, root } as Command };
  }
  if (!isSafeSkillId(rest[0])) return invalidCollectionId(kind, topic);
  return { kind: 'command', command: { name: `${plural}-${subcommand}`, id: rest[0] } as Command };
}

function invalidCollectionId(kind: 'library' | 'package', topic: HelpTopic): ParseResult {
  return usageError(`${kind === 'library' ? 'Library' : 'Package'} IDs must be 1-64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.`, topic);
}


function invalidProfileId(topic: HelpTopic): ParseResult {
  return usageError(
    'Profile IDs must be 1-64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.',
    topic
  );
}

function parseDefaultSkillLifecycle(name: 'add' | 'remove', args: readonly string[]): ParseResult {
  const topic: HelpTopic = name === 'add' ? 'add-skill' : 'remove-skill';
  if (args.length === 2 && args[0] === 'skill' && HELP_FLAGS.has(args[1])) {
    return { kind: 'help', topic };
  }
  if (args.length !== 2 || args[0] !== 'skill') {
    return usageError(`${name} requires exactly \`skill\` followed by ${name === 'add' ? '<absolute-root>' : '<skill>'}.`, topic);
  }
  const value = args[1];
  if (name === 'add') {
    if (!isAbsolute(value) || value.length === 0 || value.includes('\0')) {
      return usageError('Skill root must be a non-empty absolute path without NUL bytes.', topic);
    }
    return { kind: 'command', command: { name: 'default-skill-add', skillRoot: value } };
  }
  if (!isSafeSkillId(value)) return invalidSkillId(topic);
  return { kind: 'command', command: { name: 'default-skill-remove', skillId: value } };
}

function parseMembership(
  name: 'add' | 'remove',
  args: readonly string[],
  topic: HelpTopic
): ParseResult {
  if (args.length === 1 && HELP_FLAGS.has(args[0])) return { kind: 'help', topic };
  const hasExplicitProfile = args.length === 3 && args[1] === '--profile';
  if (!(args.length === 1 || hasExplicitProfile)) {
    return usageError(`${name} requires <skill> followed only by optional --profile <profile>.`, topic);
  }
  const skillId = args[0];
  if (!isSafeSkillId(skillId)) return invalidSkillId(topic);
  const profileId = hasExplicitProfile ? args[2] : undefined;
  if (profileId !== undefined && !isSafeProfileId(profileId)) return invalidProfileId(topic);
  return {
    kind: 'command',
    command: profileId === undefined
      ? { name: `profile-skill-${name}`, skillId }
      : { name: `profile-skill-${name}`, skillId, profileId }
  } as ParseResult;
}

function invalidSkillId(topic: HelpTopic): ParseResult {
  return usageError('Skill IDs must be 1-64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.', topic);
}

function parseProject(args: readonly string[]): ParseResult {
  if (args.length === 0) {
    return { kind: 'command', command: { name: 'projects-overview' } };
  }
  if (args.length === 1 && HELP_FLAGS.has(args[0])) {
    return { kind: 'help', topic: 'project' };
  }
  if (args[0] === 'init' || args[0] === 'uninit') return migrationError(args[0]);
  if (args[0] === 'enable' || args[0] === 'disable') {
    return parseNoArgumentCommand(`project-${args[0]}`, args.slice(1), 'project');
  }
  return usageError('project requires `enable` or `disable`.', 'project');
}

function parseGlobal(args: readonly string[]): ParseResult {
  if (args.length === 0) {
    return { kind: 'command', command: { name: 'global-overview' } };
  }
  if (args.length === 1 && HELP_FLAGS.has(args[0])) {
    return { kind: 'help', topic: 'global' };
  }
  if (args[0] === 'enable' || args[0] === 'disable') {
    return parseNoArgumentCommand(`global-${args[0]}`, args.slice(1), 'global');
  }
  return usageError('global requires `enable` or `disable`.', 'global');
}

function parsePi(args: readonly string[]): ParseResult {
  if (args.length === 1 && HELP_FLAGS.has(args[0])) {
    return { kind: 'help', topic: 'pi' };
  }

  let index = 0;
  let dryRun = false;
  if (args[index] === '--dry-run') {
    dryRun = true;
    index += 1;
  }

  let forwardedArgs: string[] = [];
  if (index < args.length) {
    if (args[index] !== '--') {
      return usageError(
        'pi accepts only --dry-run before the optional -- Pi-argument delimiter.',
        'pi'
      );
    }
    forwardedArgs = args.slice(index + 1);
  }

  try {
    assertSafeForwardedPiArgs(forwardedArgs);
  } catch (error) {
    if (error instanceof BazframeError) return usageError(error.message, 'pi');
    throw error;
  }
  return {
    kind: 'command',
    command: { name: 'pi', dryRun, forwardedArgs }
  };
}

function parseNoArgumentCommand(
  name: 'status' | 'tui' | 'global-enable' | 'global-disable' | 'project-enable' | 'project-disable',
  args: readonly string[],
  topic: HelpTopic
): ParseResult {
  if (args.length === 1 && HELP_FLAGS.has(args[0])) {
    return { kind: 'help', topic };
  }
  return args.length === 0
    ? { kind: 'command', command: { name } }
    : usageError(`${name.replace('-', ' ')} accepts no arguments.`, topic);
}

function parseAdapter(args: readonly string[]): ParseResult {
  if (args.length === 0) {
    return { kind: 'command', command: { name: 'adapters-overview' } };
  }
  if (args.length === 1 && HELP_FLAGS.has(args[0])) {
    return { kind: 'help', topic: 'adapter' };
  }
  if (args[0] === 'install' && args[1] === 'pi') {
    if (args.length === 2) {
      return { kind: 'command', command: { name: 'adapter-install-pi', force: false } };
    }
    if (args.length === 3 && args[2] === '--force') {
      return { kind: 'command', command: { name: 'adapter-install-pi', force: true } };
    }
    return usageError('adapter install pi accepts only the optional --force flag.', 'adapter');
  }
  if (args[0] === 'uninstall' && args[1] === 'pi') {
    return args.length === 2
      ? { kind: 'command', command: { name: 'adapter-uninstall-pi' } }
      : usageError('adapter uninstall pi accepts no additional arguments.', 'adapter');
  }
  return usageError('adapter requires `install pi [--force]` or `uninstall pi`.', 'adapter');
}

function migrationError(command: string): ParseResult {
  const replacement = command === 'init' ? 'enable' : 'disable';
  return usageError(
    `\`${command}\` was replaced by \`bazframe project ${replacement}\`.`,
    'project'
  );
}

function usageError(message: string, topic: HelpTopic): ParseResult {
  return { kind: 'usage-error', message, topic };
}

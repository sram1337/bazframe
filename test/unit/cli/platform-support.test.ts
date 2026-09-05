import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  WINDOWS_PLATFORM_UNSUPPORTED_CODE,
  WINDOWS_PLATFORM_UNSUPPORTED_MESSAGE
} from '../../../src/core/platform-support.js';
import { runCli, type CliDependencies } from '../../../src/cli/run-cli.js';
import { parseArgv, type Command } from '../../../src/cli/parse-argv.js';

// `profiles-overview` is a retained internal union member; parseArgv never returns it.
type ParsedCommandName = Exclude<Command['name'], 'profiles-overview'>;

const COMMAND_CASES = [
  ['profile-list', ['profile', 'list']],
  ['profile-current', ['profile', 'current']],
  ['profile-add', ['profile', 'add', 'focused']],
  ['profile-duplicate', ['profile', 'duplicate', 'focused', 'copy']],
  ['profile-remove', ['profile', 'remove', 'focused']],
  ['profile-rename', ['profile', 'rename', 'focused', 'renamed']],
  ['profile-use', ['profile', 'use', 'focused']],
  ['profile-edit', ['profile', 'edit', 'focused']],
  ['profile-export', ['profile', 'export']],
  ['profile-publish', ['profile', 'publish']],
  ['profile-import', ['profile', 'import', 'profile.zip']],
  ['profile-update', ['profile', 'update']],
  ['profile-version-list', ['profile', 'version', 'list']],
  ['profile-version-use', ['profile', 'version', 'use', 'abc123']],
  ['skills-overview', ['skill', 'list']],
  ['default-skill-add', ['skill', 'add', 'git:owner/repository']],
  ['default-skill-remove', ['skill', 'remove', 'demo']],
  ['skill-update', ['skill', 'update', 'demo']],
  ['skill-edit', ['skill', 'edit', 'demo']],
  ['libraries-overview', ['library', 'list']],
  ['libraries-add', ['library', 'add', 'git:owner/repository']],
  ['libraries-update', ['library', 'update', 'demo']],
  ['libraries-remove', ['library', 'remove', 'demo']],
  ['packages-overview', ['package', 'list']],
  ['packages-add', ['package', 'add', '--yes', 'git:owner/repository']],
  ['packages-build', ['package', 'build', 'demo']],
  ['packages-update', ['package', 'update', '--yes', 'demo']],
  ['packages-remove', ['package', 'remove', 'demo']],
  ['profile-skills-overview', ['profile', 'skill', 'list']],
  ['profile-skill-add', ['profile', 'skill', 'add', 'demo']],
  ['profile-skill-remove', ['profile', 'skill', 'remove', 'demo']],
  ['profile-libraries-overview', ['profile', 'library', 'list']],
  ['profile-libraries-add', ['profile', 'library', 'add', 'demo']],
  ['profile-libraries-remove', ['profile', 'library', 'remove', 'demo']],
  ['profile-packages-overview', ['profile', 'package', 'list']],
  ['profile-packages-add', ['profile', 'package', 'add', 'demo']],
  ['profile-packages-remove', ['profile', 'package', 'remove', 'demo']],
  ['projects-overview', ['project', 'list']],
  ['project-enable', ['project', 'enable']],
  ['project-disable', ['project', 'disable']],
  ['global-overview', ['global', 'show']],
  ['global-enable', ['global', 'enable']],
  ['global-disable', ['global', 'disable']],
  ['adapters-overview', ['adapter', 'list']],
  ['adapter-install-pi', ['adapter', 'install', 'pi']],
  ['adapter-uninstall-pi', ['adapter', 'uninstall', 'pi']],
  ['status', ['status']],
  ['tui', ['tui']],
  ['pi', ['pi', '--dry-run']]
] as const satisfies ReadonlyArray<readonly [ParsedCommandName, readonly string[]]>;

type MissingParsedCommandName = Exclude<ParsedCommandName, typeof COMMAND_CASES[number][0]>;
const PARSED_COMMAND_NAMES_ARE_COVERED: MissingParsedCommandName extends never ? true : never = true;

const JSON_UNSUPPORTED = new Set<Command['name']>(['profile-edit', 'skill-edit', 'tui', 'pi']);
const LIFECYCLE = new Set<Command['name']>([
  'profile-export',
  'profile-publish',
  'profile-import',
  'profile-update',
  'profile-version-list',
  'profile-version-use'
]);

describe('native Windows pre-acceptance platform gate', () => {
  it('keeps the table synchronized with every command shape reachable from the parser', () => {
    expect(PARSED_COMMAND_NAMES_ARE_COVERED).toBe(true);
    const names = COMMAND_CASES.map(([expected, argv]) => {
      const parsed = parseArgv(argv);
      expect(parsed.kind, argv.join(' ')).toBe('command');
      if (parsed.kind !== 'command') throw new Error('Expected command');
      expect(parsed.command.name, argv.join(' ')).toBe(expected);
      return parsed.command.name;
    });

    expect(names).toEqual([...new Set(names)]);
    expect(names).toMatchInlineSnapshot(`
      [
        "profile-list",
        "profile-current",
        "profile-add",
        "profile-duplicate",
        "profile-remove",
        "profile-rename",
        "profile-use",
        "profile-edit",
        "profile-export",
        "profile-publish",
        "profile-import",
        "profile-update",
        "profile-version-list",
        "profile-version-use",
        "skills-overview",
        "default-skill-add",
        "default-skill-remove",
        "skill-update",
        "skill-edit",
        "libraries-overview",
        "libraries-add",
        "libraries-update",
        "libraries-remove",
        "packages-overview",
        "packages-add",
        "packages-build",
        "packages-update",
        "packages-remove",
        "profile-skills-overview",
        "profile-skill-add",
        "profile-skill-remove",
        "profile-libraries-overview",
        "profile-libraries-add",
        "profile-libraries-remove",
        "profile-packages-overview",
        "profile-packages-add",
        "profile-packages-remove",
        "projects-overview",
        "project-enable",
        "project-disable",
        "global-overview",
        "global-enable",
        "global-disable",
        "adapters-overview",
        "adapter-install-pi",
        "adapter-uninstall-pi",
        "status",
        "tui",
        "pi",
      ]
    `);
  });

  it.each(COMMAND_CASES)('refuses %s before runtime, confirmation, cwd, TUI, editor, or process seams', async (_name, argv) => {
    const invocation = await invoke(argv, 'win32');

    expect(invocation.status).toBe(1);
    expect(invocation.stdout).toBe('');
    expect(invocation.stderr).toBe(
      `error: ${WINDOWS_PLATFORM_UNSUPPORTED_CODE}: ${WINDOWS_PLATFORM_UNSUPPORTED_MESSAGE}\n`
    );
    expect(invocation.reached).toEqual([]);
  });

  it.each(COMMAND_CASES.filter(([name]) => !JSON_UNSUPPORTED.has(name)))(
    'emits the stable JSON platform error for %s without reaching effects',
    async (name, argv) => {
      const invocation = await invoke([...argv, '--json'], 'win32');
      const document = JSON.parse(invocation.stdout) as Record<string, unknown>;

      expect(invocation.status).toBe(1);
      expect(invocation.stderr).toBe('');
      expect(invocation.reached).toEqual([]);
      if (LIFECYCLE.has(name)) {
        expect(document).toMatchObject({
          schemaVersion: 2,
          outcome: 'error',
          error: {
            category: 'operational',
            code: WINDOWS_PLATFORM_UNSUPPORTED_CODE,
            message: WINDOWS_PLATFORM_UNSUPPORTED_MESSAGE
          }
        });
      } else {
        expect(document).toMatchObject({
          schemaVersion: 1,
          ok: false,
          error: {
            category: 'operational',
            code: WINDOWS_PLATFORM_UNSUPPORTED_CODE,
            message: WINDOWS_PLATFORM_UNSUPPORTED_MESSAGE
          }
        });
      }
    }
  );

  it.each([
    ['root help', []],
    ['topic help', ['help', 'profile']],
    ['version', ['--version']],
    ['usage', ['status', 'extra']],
    ['migration', ['profiles']],
    ['JSON usage', ['status', 'extra', '--json']],
    ['JSON help refusal', ['--help', '--json']]
  ] as const)('keeps %s platform-neutral and bypasses effect seams', async (_label, argv) => {
    const windows = await invoke(argv, 'win32');
    const posix = await invoke(argv, 'linux');
    expect(windows).toEqual(posix);
    expect(windows.reached).toEqual([]);
  });

  it('does not import or construct the internal Windows added-Skill service from public dispatch', async () => {
    const [dispatcher, gate] = await Promise.all([
      readFile(new URL('../../../src/cli/run-cli.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/core/platform-support.ts', import.meta.url), 'utf8')
    ]);
    expect(dispatcher).not.toContain('added-skill-platform-services');
    expect(gate).not.toContain('added-skill-platform-services');
  });

  it('uses the same built dispatcher for bazframe and bzf', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      bin: Record<string, string>;
    };
    expect(manifest.bin).toEqual({ bazframe: 'dist/cli.js', bzf: 'dist/cli.js' });
  });
});

async function invoke(
  argv: readonly string[],
  platform: NodeJS.Platform
): Promise<{ status: number; stdout: string; stderr: string; reached: string[] }> {
  let stdout = '';
  let stderr = '';
  const reached: string[] = [];
  const poison = (name: string) => {
    reached.push(name);
    throw new Error(`Reached forbidden ${name} seam`);
  };
  const dependencies: CliDependencies = {
    platform,
    environment: {},
    userHome: '/not-read/bazframe-platform-gate',
    cwd: () => poison('cwd') as never,
    writeStdout: (text) => { stdout += text; },
    writeStderr: (text) => { stderr += text; },
    launchTui: async () => poison('TUI') as never,
    profileRuntime: async () => poison('profile runtime') as never,
    confirmManagedGitPackageBuild: () => poison('managed Git confirmation') as never,
    confirmProfileImportPackageBuild: () => poison('profile package confirmation') as never,
    confirmProfilePublication: () => poison('publication confirmation') as never,
    chooseProfileImportCollision: () => poison('collision confirmation') as never,
    editorChildRunner: async () => poison('editor') as never
  };
  const status = await runCli(argv, dependencies);
  return { status, stdout, stderr, reached };
}

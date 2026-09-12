import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import * as native from '../../../src/core/win32-native.js';
import { createWindowsApplicationServices } from '../../../src/application/win32-application-services.js';
import { win32 } from 'node:path';
import type { ApplicationServices } from '../../../src/application/application-services.js';
import { BazframeError } from '../../../src/core/errors.js';
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

describe('public Windows lazy routing', () => {
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

  it.each(COMMAND_CASES)('routes %s to injected Windows application services without POSIX fallback', async (name, argv) => {
    const invocation = await invoke(argv, 'win32');

    expect(invocation.status).toBe(1);
    expect(invocation.stdout).toBe('');
    expect(invocation.stderr).toBe(
      'error: Windows application reached\n'
    );
    expect(invocation.reached).toEqual([...(['projects-overview', 'project-enable', 'project-disable', 'status', 'tui', 'pi'].includes(name) ? ['cwd'] : []), 'application']);
  });

  it.each(COMMAND_CASES.filter(([name]) => !JSON_UNSUPPORTED.has(name)))(
    'retains JSON protocol for %s when Windows application admission refuses',
    async (name, argv) => {
      const invocation = await invoke([...argv, '--json'], 'win32');
      const document = JSON.parse(invocation.stdout) as Record<string, unknown>;

      if (name === 'profile-publish') {
        expect(invocation.status).toBe(2);
        expect(invocation.reached).toEqual([]);
        expect(document).toMatchObject({ schemaVersion: 2, outcome: 'refusal', refusal: { code: 'PROFILE_PUBLISH_CONFIRMATION_REQUIRED' } });
        return;
      }
      expect(invocation.status).toBe(1);
      expect(invocation.stderr).toBe('');
      expect(invocation.reached).toEqual([...(['projects-overview', 'project-enable', 'project-disable', 'status', 'tui', 'pi'].includes(name) ? ['cwd'] : []), 'application']);
      if (LIFECYCLE.has(name)) {
        expect(document).toMatchObject({
          schemaVersion: 2,
          outcome: 'error',
          error: {
            category: 'network',
            code: 'REMOTE_UNAVAILABLE',
            message: 'Windows application reached'
          }
        });
      } else {
        expect(document).toMatchObject({
          schemaVersion: 1,
          ok: false,
          error: {
            category: 'operational',
            code: 'REMOTE_UNAVAILABLE',
            message: 'Windows application reached'
          }
        });
      }
    }
  );

  it.each(COMMAND_CASES.filter(([name]) => JSON_UNSUPPORTED.has(name)))('rejects JSON for %s before application access', async (_name, argv) => {
    const windows = await invoke([...argv, '--json'], 'win32');
    expect(windows.status).toBe(2);
    expect(windows.reached).toEqual([]);
    expect(windows).toEqual(await invoke([...argv, '--json'], 'linux'));
  });

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

  it.each([
    'WINDOWS_NATIVE_PLATFORM_UNSUPPORTED', 'WINDOWS_NATIVE_ARCH_UNSUPPORTED',
    'WINDOWS_NATIVE_ARTIFACT_MISSING', 'WINDOWS_NATIVE_ARTIFACT_INCOMPATIBLE',
    'WINDOWS_NATIVE_ARTIFACT_LOAD_FAILED', 'WINDOWS_NATIVE_EXPORT_MISSING',
    'WINDOWS_NATIVE_CONTRACT_MISMATCH', 'WINDOWS_NATIVE_VERSION_MISMATCH',
    'WINDOWS_NATIVE_TARGET_MISMATCH', 'WINDOWS_NATIVE_PACKAGE_METADATA_INVALID'
  ])('retains fixed loader remediation in public lifecycle JSON-v2 for %s', async (code) => {
    const application = createWindowsApplicationServices({ backend: () => {
      throw new BazframeError(code, 'PRIVATE_OPERAND token=PRIVATE_SECRET', { cause: new Error('PRIVATE_CAUSE') });
    } });
    let stdout = '', stderr = '';
    expect(await runCli(['profile', 'export', '--json'], {
      platform: 'win32', application, environment: {}, userHome: 'C:\\unused',
      writeStdout: (text) => { stdout += text; }, writeStderr: (text) => { stderr += text; }
    })).toBe(1);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 2, outcome: 'error', error: { code, message: expect.stringMatching(/requires|Reinstall/) } });
    expect(stdout).not.toMatch(/PRIVATE_|cause|stack/);
  });

  it('keeps unknown/native-storage JSON-v2 errors closed rather than allowlisting a prefix', async () => {
    const application = createWindowsApplicationServices({ backend: () => { throw new BazframeError('WINDOWS_NATIVE_ACCESS_DENIED', 'PRIVATE_REASON'); } });
    let stdout = '';
    await runCli(['profile', 'export', '--json'], { platform: 'win32', application, environment: {}, userHome: 'C:\\unused', writeStdout: (text) => { stdout += text; }, writeStderr() {} });
    expect(JSON.parse(stdout)).toMatchObject({ error: { code: 'PROFILE_INTERNAL_ERROR' } });
    expect(stdout).not.toContain('PRIVATE_REASON');
  });

  it.each(['skill', 'library', 'package'])('parses drive-absolute %s input before selecting the non-injected Windows application', async (kind) => {
    const load = vi.spyOn(native, 'loadBazframeWin32Native').mockImplementation(() => {
      throw new BazframeError('WINDOWS_NATIVE_ARTIFACT_MISSING', 'Expected native loader route');
    });
    try {
      let stdout = '', stderr = '';
      const status = await runCli([kind, 'add', 'C:\\fixtures\\local', '--json'], {
        platform: 'win32', environment: {}, userHome: 'C:\\unused',
        writeStdout: (text) => { stdout += text; }, writeStderr: (text) => { stderr += text; }
      });
      expect(status).toBe(1);
      expect(load).toHaveBeenCalledOnce();
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 1, ok: false, error: { code: 'WINDOWS_NATIVE_ARTIFACT_MISSING' } });
    } finally { load.mockRestore(); }
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
    application: new Proxy({ paths: win32 } as ApplicationServices, { get(target, key) {
      if (key === 'paths') return target.paths;
      reached.push('application');
      throw new BazframeError('REMOTE_UNAVAILABLE', 'Windows application reached');
    } }),
    environment: {},
    userHome: '/not-read/bazframe-platform-gate',
    cwd: () => { reached.push('cwd'); return 'C:\\not-read'; },
    stdinIsTty: true, stdoutIsTty: true,
    writeStdout: (text) => { stdout += text; },
    writeStderr: (text) => { stderr += text; },
    launchTui: async (options) => { void options.application!.profiles; return poison('TUI') as never; },
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

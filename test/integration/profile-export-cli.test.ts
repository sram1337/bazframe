import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { containsUnsafeDisplayCharacters } from '../../src/core/safe-text.js';
import { createTempDirectory, type TempDirectory } from '../helpers/temp-directory.js';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const directories: TempDirectory[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));

interface Fixture {
  directory: TempDirectory;
  root: string;
  home: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
}
interface Result { status: number | null; stdout: string; stderr: string }

async function fixture(): Promise<Fixture> {
  const directory = await createTempDirectory('bazframe-profile-export-cli-');
  directories.push(directory);
  const root = await realpath(directory.root);
  const cwd = await directory.mkdir('cwd');
  const home = `${root}/home`;
  const environment = { ...process.env, BAZFRAME_HOME: home, PI_CODING_AGENT_DIR: `${root}/pi`, NO_COLOR: '1' };
  expect(run(['profile', 'add', 'portable'], cwd, environment).status).toBe(0);
  return { directory, root, home, cwd, environment };
}

function run(args: string[], cwd: string, environment: NodeJS.ProcessEnv): Result {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, env: environment, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const skill = (name: string) => `---\nname: ${name}\ndescription: Export integration fixture.\n---\n# ${name}\n`;

// The publisher contract intentionally fails closed on Windows until private/no-follow behavior is established.
describe.skipIf(process.platform === 'win32')('profile export CLI', () => {
  it('publishes exact instruction bytes and a canonical two-file artifact without exporting unrelated state', async () => {
    const f = await fixture();
    const bytes = Buffer.from('exact\r\nmultibyte: é 世界\n', 'utf8');
    await writeFile(`${f.home}/profiles/portable/AGENTS.md`, bytes);
    expect(run(['profile', 'add', 'active'], f.cwd, f.environment).status).toBe(0);
    expect(run(['profile', 'use', 'active'], f.cwd, f.environment).status).toBe(0);
    await writeFile(`${f.home}/profile-favorites.json`, '{"schemaVersion":1,"profiles":["active"]}\n');
    const output = `${f.root}/exports/portable`;
    await mkdir(`${f.root}/exports`);

    const exported = run(['profile', 'export', 'portable', '--output', output], f.cwd, f.environment);
    expect(exported.status, JSON.stringify(exported)).toBe(0);
    expect(exported.stdout).toContain('Profile export: published');
    expect(exported.stdout).toContain(`Output: ${output}`);
    expect(exported.stdout).toContain('Packages: absent (Stage 1)');
    expect(exported.stderr).toBe(`warning: Review ${output}/profile/AGENTS.md before sharing the export.\n`);
    expect(await readFile(`${output}/profile/AGENTS.md`)).toEqual(bytes);
    expect(await readdir(output)).toEqual(['bazframe-profile.json', 'profile']);
    expect(await readdir(`${output}/profile`)).toEqual(['AGENTS.md']);
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(await readFile(`${output}/bazframe-profile.json`, 'utf8')).toBe(`${JSON.stringify({
      schemaVersion: 1,
      kind: 'bazframe-profile-export',
      profile: { id: 'portable', instructions: { path: 'profile/AGENTS.md', sha256: digest }, skills: [], omittedLocalSkills: [], libraries: [], packages: [] },
      resources: []
    }, null, 2)}\n`);
    expect(await readFile(`${f.home}/active-profile`, 'utf8')).toBe('active\n');
  });

  it('names each omitted local Skill in deterministic prose and JSON warnings', async () => {
    const f = await fixture();
    for (const id of ['z-local', 'a-local']) {
      const root = `${f.root}/${id}`;
      await mkdir(root);
      await writeFile(`${root}/SKILL.md`, skill(id));
      expect(run(['skill', 'add', root], f.cwd, f.environment).status).toBe(0);
      expect(run(['profile', 'skill', 'add', '--profile', 'portable', id], f.cwd, f.environment).status).toBe(0);
    }
    await mkdir(`${f.root}/exports`);
    const proseOutput = `${f.root}/exports/prose`;
    const prose = run(['profile', 'export', 'portable', `--output=${proseOutput}`], f.cwd, f.environment);
    expect(prose.status, JSON.stringify(prose)).toBe(0);
    expect(prose.stdout).toContain('Omitted local Skills:\n  - a-local\n  - z-local');
    expect(prose.stdout).not.toContain('a-local, z-local');
    expect(prose.stderr).toBe([
      'warning: Local Skill a-local was omitted from the export and recorded in omittedLocalSkills.',
      'warning: Local Skill z-local was omitted from the export and recorded in omittedLocalSkills.',
      `warning: Review ${proseOutput}/profile/AGENTS.md before sharing the export.`,
      ''
    ].join('\n'));

    const jsonOutput = `${f.root}/exports/json`;
    const json = run(['--json', 'profile', 'export', '--output', jsonOutput, 'portable'], f.cwd, f.environment);
    expect(json.status, JSON.stringify(json)).toBe(0);
    expect(json.stderr).toBe('');
    expect(json.stdout.trim().split('\n')).toHaveLength(1);
    const document = JSON.parse(json.stdout);
    expect(document).toMatchObject({
      command: 'profile.export',
      result: { omittedLocalSkills: ['a-local', 'z-local'], packages: [] },
      diagnostics: [
        { code: 'PROFILE_EXPORT_LOCAL_SKILL_OMITTED', message: expect.stringContaining('a-local') },
        { code: 'PROFILE_EXPORT_LOCAL_SKILL_OMITTED', message: expect.stringContaining('z-local') },
        { code: 'PROFILE_EXPORT_REVIEW_INSTRUCTIONS', message: expect.stringContaining(`${jsonOutput}/profile/AGENTS.md`) }
      ]
    });
    for (const line of [...prose.stdout.split('\n'), ...prose.stderr.split('\n')]) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(1024);
    }
  });

  it('bounds long output paths in prose while preserving exact JSON data', async () => {
    const f = await fixture();
    const segments = Array.from({ length: 9 }, (_, index) => `${index}-${'x'.repeat(90)}`);
    const longParent = [f.root, 'exports', ...segments].join('/');
    await mkdir(longParent, { recursive: true });
    const proseOutput = `${longParent}/prose`;
    const prose = run(['profile', 'export', 'portable', '--output', proseOutput], f.cwd, f.environment);
    expect(prose.status, JSON.stringify(prose)).toBe(0);
    expect(prose.stdout).toContain('Output: [path omitted: escaped display exceeds 768 UTF-8 bytes]');
    expect(prose.stderr).toBe('warning: Review [path omitted: escaped display exceeds 768 UTF-8 bytes] before sharing the export.\n');
    expect(prose.stdout).not.toContain(proseOutput);
    for (const line of [...prose.stdout.split('\n'), ...prose.stderr.split('\n')]) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(1024);
    }

    const jsonOutput = `${longParent}/json`;
    const json = run(['profile', 'export', 'portable', '--output', jsonOutput, '--json'], f.cwd, f.environment);
    expect(json.status, JSON.stringify(json)).toBe(0);
    const document = JSON.parse(json.stdout);
    expect(document.result.outputPath).toBe(jsonOutput);
    expect(document.diagnostics).toContainEqual({
      level: 'warning',
      code: 'PROFILE_EXPORT_REVIEW_INSTRUCTIONS',
      message: 'Review [path omitted: escaped display exceeds 768 UTF-8 bytes] before sharing the export.'
    });
  });

  it('does not read or change active selection when explicitly exporting an inactive profile', async () => {
    const f = await fixture();
    expect(run(['profile', 'add', 'active'], f.cwd, f.environment).status).toBe(0);
    expect(run(['profile', 'use', 'active'], f.cwd, f.environment).status).toBe(0);
    await mkdir(`${f.root}/exports`);
    expect(run(['profile', 'export', 'portable', '--output', `${f.root}/exports/inactive`], f.cwd, f.environment).status).toBe(0);
    expect(await readFile(`${f.home}/active-profile`, 'utf8')).toBe('active\n');
    await writeFile(`${f.home}/active-profile`, 'malformed id\n');
    expect(run(['profile', 'export', 'portable', '--output', `${f.root}/exports/inactive-again`], f.cwd, f.environment).status).toBe(0);
    expect(await readFile(`${f.home}/active-profile`, 'utf8')).toBe('malformed id\n');
  });

  it('bounds and escapes source-validation errors containing unsafe long paths', async () => {
    const f = await fixture();
    const unsafeParent = `${f.root}/unsafe\n\u001b\u0085\u202e-${'x'.repeat(120)}`;
    const longParent = [unsafeParent, ...Array.from({ length: 6 }, (_, index) => `${index}-${'y'.repeat(120)}`)].join('/');
    const id = 'broken-export-skill';
    const source = `${longParent}/${id}`;
    await mkdir(source, { recursive: true });
    await writeFile(`${source}/SKILL.md`, skill(id));
    expect(run(['skill', 'add', source], f.cwd, f.environment).status).toBe(0);
    expect(run(['profile', 'skill', 'add', '--profile', 'portable', id], f.cwd, f.environment).status).toBe(0);
    await rm(unsafeParent, { recursive: true, force: true });
    await mkdir(`${f.root}/exports`);

    const failed = run(['profile', 'export', 'portable', '--output', `${f.root}/exports/broken`], f.cwd, f.environment);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain('The export output was not published.');
    expect(failed.stderr).toContain('[value omitted: escaped display exceeds 768 UTF-8 bytes]');
    expect(Buffer.byteLength(failed.stderr, 'utf8')).toBeLessThan(1_024);
    expect(failed.stderr.slice(0, -1)).not.toContain('\n');
    expect(failed.stderr).not.toContain('\u001b');
    expect(failed.stderr).not.toContain('\u0085');
    expect(failed.stderr).not.toContain('\u202e');
  });

  it('refuses occupied output and output overlapping BAZFRAME_HOME without publication', async () => {
    const f = await fixture();
    await mkdir(`${f.root}/exports/occupied`, { recursive: true });
    const occupied = run(['profile', 'export', 'portable', '--output', `${f.root}/exports/occupied`], f.cwd, f.environment);
    expect(occupied.status).toBe(1);
    expect(occupied.stderr).toContain('not published');

    const controlOutput = `${f.root}/exports/occupied\n\u001b\u0085\u202e`;
    await mkdir(controlOutput);
    const jsonOccupied = run(['profile', 'export', 'portable', '--output', controlOutput, '--json'], f.cwd, f.environment);
    expect(jsonOccupied.status).toBe(1);
    expect(jsonOccupied.stderr).toBe('');
    const document = JSON.parse(jsonOccupied.stdout);
    expect(document.error).toMatchObject({
      category: 'operational',
      code: 'PROFILE_EXPORT_FAILED',
      commitState: 'not-published',
      outputPath: controlOutput
    });
    expect(document.error.message).toContain('\\u000a\\u001b\\u0085\\u202e');
    expect(containsUnsafeDisplayCharacters(document.error.message)).toBe(false);
    for (const forbidden of ['staging', 'checkout', 'evidence', 'internal']) {
      expect(JSON.stringify(document)).not.toContain(forbidden);
    }

    const overlap = run(['profile', 'export', 'portable', '--output', `${f.home}/export`], f.cwd, f.environment);
    expect(overlap.status).toBe(1);
    expect(overlap.stderr).toContain('not published');
    await expect(readFile(`${f.home}/export/bazframe-profile.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks local libraries and all packages in Stage 1', async () => {
    const f = await fixture();
    const library = `${f.root}/local-library`;
    await mkdir(`${library}/library-skill`, { recursive: true });
    await writeFile(`${library}/library-skill/SKILL.md`, skill('library-skill'));
    expect(run(['library', 'add', library], f.cwd, f.environment).status).toBe(0);
    expect(run(['profile', 'library', 'add', '--profile', 'portable', 'local-library'], f.cwd, f.environment).status).toBe(0);
    await mkdir(`${f.root}/exports`);
    const blockedLibrary = run(['profile', 'export', 'portable', '--output', `${f.root}/exports/library`], f.cwd, f.environment);
    expect(blockedLibrary.status).toBe(1);
    expect(blockedLibrary.stderr).toContain('does not support local library');

    expect(run(['profile', 'library', 'remove', '--profile', 'portable', 'local-library'], f.cwd, f.environment).status).toBe(0);
    const packageRoot = `${f.root}/local-package`;
    await mkdir(packageRoot);
    await writeFile(`${packageRoot}/build.mjs`, "import{mkdir,writeFile}from'node:fs/promises';await mkdir('dist/skills/package-skill',{recursive:true});await writeFile('dist/skills/package-skill/SKILL.md','---\\nname: package-skill\\ndescription: Package fixture.\\n---\\n');\n");
    await writeFile(`${packageRoot}/bazframe-package.json`, JSON.stringify({ schemaVersion: 1, build: [process.execPath, 'build.mjs'], artifactRoot: 'dist', skillsRoot: 'skills' }));
    expect(run(['package', 'add', packageRoot], f.cwd, f.environment).status).toBe(0);
    expect(run(['profile', 'package', 'add', '--profile', 'portable', 'local-package'], f.cwd, f.environment).status).toBe(0);
    const blockedPackage = run(['profile', 'export', 'portable', '--output', `${f.root}/exports/package`], f.cwd, f.environment);
    expect(blockedPackage.status).toBe(1);
    expect(blockedPackage.stderr).toContain('does not support package references');
  });
});

import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { captureManifest } from './manifest.mjs';

const execute = promisify(execFile);
const experimentRoot = dirname(fileURLToPath(import.meta.url));
const workRoot = join(experimentRoot, '.work');

export async function writeSkill(directory, name, body = '') {
  await mkdir(directory, { recursive: true });
  const suffix = body.length === 0 ? '' : `\n${body.trim()}\n`;
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Experiment fixture skill ${name}.\n---\n${suffix}`
  );
}

export async function populateStandardSource({ sourceRoot }) {
  await writeSkill(
    join(sourceRoot, 'alpha'),
    'alpha',
    'Read [the shared reference](../shared/reference.md).'
  );
  await writeSkill(
    join(sourceRoot, 'beta'),
    'beta',
    'Read [the shared reference](../shared/reference.md).'
  );
  await mkdir(join(sourceRoot, 'shared'), { recursive: true });
  await writeFile(join(sourceRoot, 'shared', 'reference.md'), 'provider-owned shared reference\n');
  await writeFile(join(sourceRoot, 'ordinary.txt'), 'not a skill\n');
}

async function initializeRepository(path) {
  await mkdir(path, { recursive: true });
  await execute('git', ['init', '--quiet', '--template=', path], {
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1'
    }
  });
}

async function initializeDestination(path, label) {
  await initializeRepository(path);
  await writeFile(join(path, 'README.md'), `# ${label}\n`);
}

async function gitStatus(path) {
  const { stdout } = await execute('git', ['status', '--short'], {
    cwd: path,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1'
    }
  });
  return stdout;
}

async function changeTreeModes(root, writable) {
  const stats = await lstat(root);
  if (stats.isSymbolicLink()) return;
  const currentMode = stats.mode & 0o777;
  if (stats.isDirectory()) {
    if (writable) await chmod(root, currentMode | 0o200);
    for (const name of await readdir(root)) {
      await changeTreeModes(join(root, name), writable);
    }
    if (!writable) await chmod(root, currentMode & ~0o222);
    return;
  }
  await chmod(root, writable ? currentMode | 0o200 : currentMode & ~0o222);
}

function isWithin(path, root) {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..');
}

/** Assert that every non-link entry outside the isolated home lacks write bits. */
export async function assertOnlyBazframeHomeWritable(fixture) {
  async function visit(path) {
    const stats = await lstat(path);
    if (!stats.isSymbolicLink() && !isWithin(path, fixture.bazframeHome)) {
      if ((stats.mode & 0o222) !== 0) throw new Error(`Writable path outside isolated home: ${path}`);
    }
    if (!stats.isDirectory() || isWithin(path, fixture.bazframeHome)) return;
    for (const name of await readdir(path)) await visit(join(path, name));
  }
  await visit(fixture.workspace);
}

/**
 * Prepare all immutable inputs before capturing the mutation-window baseline.
 * populate is the sole writer of provider bytes.
 */
export async function prepareFixture(options = {}) {
  const {
    providerId = 'fixture-provider',
    sourceId = 'fixture-source',
    sourceName = 'fixture-source',
    populate = populateStandardSource,
    setupHome = async () => {}
  } = options;

  await mkdir(workRoot, { recursive: true });
  const workspace = await mkdtemp(join(workRoot, 'structural-'));
  const bazframeHome = join(workspace, 'bazframe-home');
  const membershipDirectory = join(bazframeHome, 'memberships');
  const providerRoot = join(workspace, 'provider');
  const sourceRoot = join(providerRoot, sourceName);
  const destinationsRoot = join(workspace, 'destinations');
  const destinationRoots = [
    join(destinationsRoot, 'session-a'),
    join(destinationsRoot, 'session-b')
  ];

  await initializeRepository(providerRoot);
  await mkdir(sourceRoot, { recursive: true });
  await populate({ sourceRoot, writeSkill });
  await initializeDestination(destinationRoots[0], 'session a');
  await initializeDestination(destinationRoots[1], 'session b');
  await mkdir(membershipDirectory, { recursive: true });
  const membershipPath = join(membershipDirectory, sourceId);
  await symlink(sourceRoot, membershipPath, 'dir');
  await setupHome({ bazframeHome, membershipPath, providerRoot, sourceRoot, destinationRoots });

  const destinationGitStatus = await Promise.all(destinationRoots.map(gitStatus));
  await changeTreeModes(providerRoot, false);
  await changeTreeModes(destinationsRoot, false);
  await chmod(workspace, 0o555);

  const before = {
    provider: await captureManifest(providerRoot),
    destinations: await Promise.all(destinationRoots.map(captureManifest))
  };

  const fixture = {
    workspace,
    bazframeHome,
    providerId,
    sourceId,
    providerRoot,
    sourceRoot,
    destinationsRoot,
    destinationRoots,
    destinationGitStatus,
    membershipPath,
    before,
    gitStatus: (path) => gitStatus(path)
  };
  await assertOnlyBazframeHomeWritable(fixture);

  async function cleanup() {
    await chmod(workspace, 0o755).catch(() => {});
    await changeTreeModes(providerRoot, true).catch(() => {});
    await changeTreeModes(destinationsRoot, true).catch(() => {});
    await rm(workspace, { force: true, recursive: true });
  }

  return { ...fixture, cleanup };
}

export async function captureImmutableInputs(fixture) {
  return {
    provider: await captureManifest(fixture.providerRoot),
    destinations: await Promise.all(fixture.destinationRoots.map(captureManifest))
  };
}

export async function prepareBrokenMembership(options = {}) {
  const providerId = options.providerId ?? 'fixture-provider';
  const sourceId = options.sourceId ?? 'missing-source';
  await mkdir(workRoot, { recursive: true });
  const workspace = await mkdtemp(join(workRoot, 'broken-'));
  const bazframeHome = join(workspace, 'bazframe-home');
  const membershipDirectory = join(bazframeHome, 'memberships');
  await mkdir(membershipDirectory, { recursive: true });
  const membershipPath = join(membershipDirectory, sourceId);
  await symlink(join(workspace, 'provider', 'absent'), membershipPath, 'dir');

  return {
    workspace,
    bazframeHome,
    providerId,
    sourceId,
    membershipPath,
    cleanup: () => rm(workspace, { force: true, recursive: true })
  };
}

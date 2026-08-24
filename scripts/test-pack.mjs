import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PACKED_TUI_DEADLINE_MS = 8_000;
const projectRoot = process.cwd();
const npmExecPath = process.env.npm_execpath;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'bazframe-2-pack-'));
let tarballPath;

if (!npmExecPath) {
  throw new Error('test:pack must run through npm so npm_execpath is available.');
}

try {
  const output = execFileSync(
    process.execPath,
    [npmExecPath, 'pack', '--json'],
    { cwd: projectRoot, encoding: 'utf8' }
  );
  const [{ filename }] = JSON.parse(output);
  tarballPath = resolve(projectRoot, filename);

  execFileSync(process.execPath, [npmExecPath, 'init', '-y'], {
    cwd: temporaryRoot,
    stdio: 'ignore'
  });
  execFileSync(
    process.execPath,
    [npmExecPath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    { cwd: temporaryRoot, stdio: 'ignore' }
  );

  const packageRoot = join(temporaryRoot, 'node_modules', 'bazframe-2-prototype');
  const packagedCli = join(packageRoot, 'dist', 'cli.js');
  assertExists(packagedCli);
  if (process.platform !== 'win32' && (statSync(packagedCli).mode & 0o111) === 0) {
    throw new Error(`Expected packaged CLI to be executable: ${packagedCli}`);
  }
  assertExists(join(packageRoot, 'dist', 'tui', 'run-tui.js'));
  assertExists(join(packageRoot, 'dist', 'application', 'tui-service.js'));
  assertExists(join(packageRoot, 'dist', 'profiles', 'profile-skill-collection-reference.js'));
  assertExists(join(packageRoot, 'dist', 'profiles', 'profile-skill-collection-reference-lifecycle.js'));
  assertExists(join(packageRoot, 'dist', 'profiles', 'profile-instruction-editor.js'));
  assertExists(join(packageRoot, 'dist', 'skills', 'skill-definition-editor.js'));
  assertExists(join(packageRoot, 'dist', 'core', 'child-process.js'));
  assertExists(join(packageRoot, 'dist', 'core', 'external-editor.js'));
  assertExists(join(packageRoot, 'dist', 'skill-collections', 'skill-collection-store.js'));
  assertExists(join(packageRoot, 'dist', 'skill-collections', 'skill-collection-lifecycle.js'));
  assertExists(join(packageRoot, 'dist', 'skill-collections', 'skill-collection-resolver.js'));
  assertExists(join(packageRoot, 'dist', 'skill-collections', 'skill-collection-preparation.js'));
  assertExists(join(packageRoot, 'dist', 'skill-collections', 'skill-snapshot.js'));
  assertExists(join(packageRoot, 'dist', 'packages', 'package-manifest.js'));
  assertMissing(join(packageRoot, 'dist', 'sources'));
  assertMissing(join(packageRoot, 'dist', 'source-units'));
  assertMissing(join(packageRoot, 'dist', 'profiles', 'profile-source-reference.js'));
  assertMissing(join(packageRoot, 'dist', 'profiles', 'profile-source-reference-lifecycle.js'));
  const packagedSkill = join(packageRoot, 'dist', 'skills', 'bazframe', 'SKILL.md');
  assertExists(packagedSkill);
  if (readFileSync(packagedSkill, 'utf8') !== readFileSync(join(projectRoot, 'skills', 'bazframe', 'SKILL.md'), 'utf8')) {
    throw new Error('Packaged Bazframe skill does not exactly match its tracked source.');
  }
  const packagedBazifyRoot = join(packageRoot, 'dist', 'skills', 'bazify');
  const packagedBazifyScript = join(packagedBazifyRoot, 'scripts', 'bazify.mjs');
  for (const relativePath of ['SKILL.md', join('scripts', 'bazify.mjs')]) {
    const packagedPath = join(packagedBazifyRoot, relativePath);
    const trackedPath = join(projectRoot, 'skills', 'bazify', relativePath);
    assertExists(packagedPath);
    if (readFileSync(packagedPath, 'utf8') !== readFileSync(trackedPath, 'utf8')) {
      throw new Error(`Packaged Bazify file does not exactly match its tracked source: ${relativePath}`);
    }
  }
  assertMissing(join(packageRoot, 'skills', 'bazframe'));
  assertMissing(join(packageRoot, 'skills', 'bazify'));
  assertExists(join(packageRoot, 'artifacts', 'pi', 'bazframe.ts'));
  assertExists(join(packageRoot, 'README.md'));
  assertExists(join(packageRoot, 'docs', 'prototype.md'));
  assertExists(join(packageRoot, 'docs', 'design.md'));
  assertExists(join(packageRoot, 'docs', 'pi-adaptive-context-adapter.md'));
  assertExists(join(packageRoot, 'docs', 'pi-adapter-production-design.md'));
  assertExists(join(packageRoot, 'docs', 'research', 'origin-and-rationale.md'));
  assertExists(join(packageRoot, 'docs', 'research', 'prototype-alternatives.md'));
  assertMissing(join(packageRoot, 'docs', 'reviews'));
  assertExists(join(packageRoot, 'TODO.md'));
  assertExists(join(packageRoot, 'examples', 'profiles', 'focused', 'AGENTS.md'));
  assertExists(join(packageRoot, 'examples', 'profiles', 'reviewer', 'AGENTS.md'));
  assertMissing(join(packageRoot, 'src'));
  assertMissing(join(packageRoot, 'test'));
  assertMissing(join(packageRoot, 'scripts'));

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.bin?.bazframe !== './dist/cli.js') {
    throw new Error(`Unexpected packaged bin target: ${manifest.bin?.bazframe}`);
  }
  if (
    manifest.dependencies?.['@earendil-works/pi-coding-agent'] !== '0.82.0'
    || manifest.dependencies?.ink !== '7.1.1'
    || manifest.dependencies?.react !== '19.2.8'
  ) {
    throw new Error('Expected exact packaged Pi 0.82.0, Ink, and React runtime dependencies.');
  }

  const executable = process.platform === 'win32'
    ? join(temporaryRoot, 'node_modules', '.bin', 'bazframe.cmd')
    : join(temporaryRoot, 'node_modules', '.bin', 'bazframe');
  const packedCatalogHome = join(temporaryRoot, 'packed-catalog-home');
  const registeredSkill = spawnSync(executable, ['add', 'skill', packagedSkill.replace(/\/SKILL\.md$/u, '')], {
    encoding: 'utf8', shell: false, env: { ...process.env, BAZFRAME_HOME: packedCatalogHome }
  });
  if (registeredSkill.status !== 0 || !registeredSkill.stdout.includes('Default skill registration: added')) {
    throw new Error(`Packed skill registration failed (${registeredSkill.status}).\nstdout: ${registeredSkill.stdout}\nstderr: ${registeredSkill.stderr}`);
  }
  const catalogLink = join(packedCatalogHome, 'skills', 'bazframe');
  if (readFileSync(join(catalogLink, 'SKILL.md'), 'utf8') !== readFileSync(packagedSkill, 'utf8')) {
    throw new Error('Packed catalog registration does not resolve the packaged skill bytes.');
  }

  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', shell: false });
  if (result.status !== 0 || result.stdout !== 'Bazframe 2 prototype 0.0.0-prototype.0\n') {
    throw new Error(
      `Installed CLI version check failed (${result.status}).\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }

  const bazifySource = join(temporaryRoot, 'bazify-provider', 'packed-bazify-skill');
  const bazifyDestination = join(temporaryRoot, 'bazify-output', 'packed-bazify-skill');
  mkdirSync(bazifySource, { recursive: true });
  mkdirSync(join(temporaryRoot, 'bazify-output'), { recursive: true });
  writeFileSync(join(bazifySource, 'SKILL.md'), '---\nname: packed-bazify-skill\ndescription: Packed Bazify acceptance Skill.\n---\n# Packed Bazify Skill\n');
  writeFileSync(join(bazifySource, 'reference.txt'), 'packed reference\n');
  const bazified = spawnSync(process.execPath, [
    packagedBazifyScript,
    'create',
    bazifySource,
    '--destination',
    bazifyDestination,
    '--bazframe-command',
    executable
  ], { encoding: 'utf8', shell: false });
  if (bazified.status !== 0) {
    throw new Error(`Packed Bazify create failed (${bazified.status}).\nstdout: ${bazified.stdout}\nstderr: ${bazified.stderr}`);
  }
  const bazifiedResult = JSON.parse(bazified.stdout);
  if (bazifiedResult.packageName !== 'packed-bazify-skill' || bazifiedResult.status !== 'created') {
    throw new Error(`Packed Bazify create returned an unexpected result: ${bazified.stdout}`);
  }
  assertExists(join(bazifyDestination, 'bazframe-package.json'));
  assertExists(join(bazifyDestination, 'skills', 'packed-bazify-skill', 'reference.txt'));
  assertExists(join(bazifyDestination, 'dist', 'skills', 'packed-bazify-skill', 'SKILL.md'));
  const bazifyValidated = spawnSync(process.execPath, [
    packagedBazifyScript,
    'validate',
    bazifyDestination,
    '--bazframe-command',
    executable
  ], { encoding: 'utf8', shell: false });
  if (bazifyValidated.status !== 0 || JSON.parse(bazifyValidated.stdout).status !== 'valid') {
    throw new Error(`Packed Bazify validation failed (${bazifyValidated.status}).\nstdout: ${bazifyValidated.stdout}\nstderr: ${bazifyValidated.stderr}`);
  }
  const adaptedRoot = join(temporaryRoot, 'packed-adapted-skills');
  mkdirSync(join(adaptedRoot, 'skills', 'adapted-one'), { recursive: true });
  mkdirSync(join(adaptedRoot, 'skills', 'adapted-two'), { recursive: true });
  writeFileSync(join(adaptedRoot, 'skills', 'adapted-one', 'SKILL.md'), '---\nname: adapted-one\ndescription: First adapted Skill.\n---\n# One\n');
  writeFileSync(join(adaptedRoot, 'skills', 'adapted-two', 'SKILL.md'), '---\nname: adapted-two\ndescription: Second adapted Skill.\n---\n# Two\n');
  const adapted = spawnSync(process.execPath, [
    packagedBazifyScript,
    'adapt',
    adaptedRoot,
    '--bazframe-command',
    executable
  ], { encoding: 'utf8', shell: false });
  if (adapted.status !== 0 || JSON.parse(adapted.stdout).status !== 'adapted') {
    throw new Error(`Packed Bazify adapt failed (${adapted.status}).\nstdout: ${adapted.stdout}\nstderr: ${adapted.stderr}`);
  }
  assertExists(join(adaptedRoot, 'dist', 'skills', 'adapted-one', 'SKILL.md'));
  assertExists(join(adaptedRoot, 'dist', 'skills', 'adapted-two', 'SKILL.md'));

  const collectionHome = join(temporaryRoot, 'packed-collection-home');
  const collectionEnvironment = { ...process.env, BAZFRAME_HOME: collectionHome, NO_COLOR: '1' };
  runInstalled(executable, ['profile', 'add', 'focused'], collectionEnvironment, 'Profile lifecycle: added');
  runInstalled(executable, ['profile', 'use', 'focused'], collectionEnvironment, 'Active profile: focused');
  const libraryRoot = join(temporaryRoot, 'packed-library');
  mkdirSync(join(libraryRoot, 'library-skill'), { recursive: true });
  writeFileSync(join(libraryRoot, 'library-skill', 'SKILL.md'), '---\nname: library-skill\ndescription: Packed library Skill.\n---\n# Library\n');
  runInstalled(executable, ['libraries', 'add', libraryRoot], collectionEnvironment, 'Global library: added');
  runInstalled(executable, ['profile', 'libraries', 'add', 'packed-library'], collectionEnvironment, 'Profile library reference: added');
  writeFileSync(join(libraryRoot, 'provider-update.txt'), 'updated\n');
  runInstalled(executable, ['libraries', 'update', 'packed-library'], collectionEnvironment, 'Global library: updated');
  const fixturePackageRoot = join(temporaryRoot, 'packed-package');
  mkdirSync(fixturePackageRoot, { recursive: true });
  writeFileSync(join(fixturePackageRoot, 'build.mjs'), "import{mkdir,writeFile}from'node:fs/promises';await mkdir('dist/skills/package-skill',{recursive:true});await writeFile('dist/skills/package-skill/SKILL.md','---\\nname: package-skill\\ndescription: Packed package Skill.\\n---\\n# Package\\n');\n");
  writeFileSync(join(fixturePackageRoot, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: [process.execPath, 'build.mjs'], artifactRoot: 'dist', skillsRoot: 'skills' }));
  runInstalled(executable, ['packages', 'add', fixturePackageRoot], collectionEnvironment, 'Global package: added');
  runInstalled(executable, ['profile', 'packages', 'add', 'packed-package'], collectionEnvironment, 'Profile package reference: added');
  runInstalled(executable, ['packages', 'build', 'packed-package'], collectionEnvironment, 'Global package: built');
  const obsolete = spawnSync(executable, ['sources'], { encoding: 'utf8', shell: false, env: collectionEnvironment });
  if (obsolete.status !== 2 || existsSync(join(collectionHome, 'sources'))) throw new Error(`Obsolete sources command was not inert.\nstdout: ${obsolete.stdout}\nstderr: ${obsolete.stderr}`);

  const editorHelp = spawnSync(executable, ['help', 'profile', 'edit'], {
    encoding: 'utf8', shell: false
  });
  if (
    editorHelp.status !== 0
    || !editorHelp.stdout.includes('bazframe profile edit <profile>')
    || !editorHelp.stdout.includes('wrapper executable')
  ) {
    throw new Error(
      `Packed profile editor help failed (${editorHelp.status}).\nstdout: ${editorHelp.stdout}\nstderr: ${editorHelp.stderr}`
    );
  }

  const skillEditorHelp = spawnSync(executable, ['help', 'skill', 'edit'], {
    encoding: 'utf8', shell: false
  });
  if (
    skillEditorHelp.status !== 0
    || !skillEditorHelp.stdout.includes('bazframe skill edit <skill>')
    || !skillEditorHelp.stdout.includes('edit provider input')
    || !skillEditorHelp.stdout.includes('bazframe libraries update <library>')
    || !skillEditorHelp.stdout.includes('bazframe packages build <package>')
  ) {
    throw new Error(
      `Packed skill editor help failed (${skillEditorHelp.status}).\nstdout: ${skillEditorHelp.stdout}\nstderr: ${skillEditorHelp.stderr}`
    );
  }

  const nonInteractiveTui = spawnSync(executable, ['tui'], {
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, BAZFRAME_HOME: join(temporaryRoot, 'unused-tui-home') }
  });
  if (
    nonInteractiveTui.status !== 1
    || nonInteractiveTui.stdout !== ''
    || !nonInteractiveTui.stderr.includes('requires interactive stdin and stdout')
    || nonInteractiveTui.stderr.includes('\u001B')
  ) {
    throw new Error(
      `Packed non-interactive TUI check failed (${nonInteractiveTui.status}).\nstdout: ${nonInteractiveTui.stdout}\nstderr: ${nonInteractiveTui.stderr}`
    );
  }
  assertMissing(join(temporaryRoot, 'unused-tui-home'));

  if (
    process.platform !== 'win32'
    && spawnSync('sh', ['-c', 'command -v script >/dev/null 2>&1']).status === 0
  ) {
    const packedTui = await runPackedTui(executable, temporaryRoot);
    if (packedTui.status !== 0
      || !packedTui.stdout.includes('\u001B[?1049h')
      || !packedTui.stdout.includes('\u001B[?1049l')) {
      throw new Error(
        `Packed interactive TUI check failed (${packedTui.status}).\nstdout: ${packedTui.stdout}\nstderr: ${packedTui.stderr}`
      );
    }
  }

  const lifecycleEnvironment = {
    ...process.env,
    BAZFRAME_HOME: join(temporaryRoot, 'bazframe-home'),
    PI_CODING_AGENT_DIR: join(temporaryRoot, 'pi-agent')
  };
  const installed = spawnSync(executable, ['adapter', 'install', 'pi'], {
    encoding: 'utf8',
    shell: false,
    env: lifecycleEnvironment
  });
  if (installed.status !== 0 || !installed.stdout.includes('Pi adapter: installed')) {
    throw new Error(
      `Packed adapter install failed (${installed.status}).\nstdout: ${installed.stdout}\nstderr: ${installed.stderr}`
    );
  }
  assertExists(join(temporaryRoot, 'pi-agent', 'extensions', 'bazframe.ts'));
  assertExists(join(temporaryRoot, 'bazframe-home', 'adapters', 'pi.json'));

  const uninstalled = spawnSync(executable, ['adapter', 'uninstall', 'pi'], {
    encoding: 'utf8',
    shell: false,
    env: lifecycleEnvironment
  });
  if (uninstalled.status !== 0 || !uninstalled.stdout.includes('Pi adapter: uninstalled')) {
    throw new Error(
      `Packed adapter uninstall failed (${uninstalled.status}).\nstdout: ${uninstalled.stdout}\nstderr: ${uninstalled.stderr}`
    );
  }
  assertMissing(join(temporaryRoot, 'pi-agent', 'extensions', 'bazframe.ts'));
} finally {
  if (tarballPath !== undefined && existsSync(tarballPath)) unlinkSync(tarballPath);
  makeWritable(temporaryRoot);
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
}

function makeWritable(path) {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  try { chmodSync(path, metadata.isDirectory() ? 0o700 : 0o600); } catch { /* best-effort cleanup */ }
  if (metadata.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
}

function runInstalled(executable, args, environment, expectedOutput) {
  const result = spawnSync(executable, args, { encoding: 'utf8', shell: false, env: environment });
  if (result.status !== 0 || !result.stdout.includes(expectedOutput)) {
    throw new Error(`Installed command failed: bazframe ${args.join(' ')} (${result.status}).\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return result;
}

async function runPackedTui(executable, temporaryRoot) {
  const deadline = Date.now() + PACKED_TUI_DEADLINE_MS;
  const scriptCommand = process.platform === 'darwin'
    ? `script -q /dev/null ${shellQuote(executable)} tui`
    : `script -q -e -c ${shellQuote(`exec ${shellQuote(executable)} tui`)} /dev/null`;
  // The shell pipeline gives BSD script a real pipe rather than Node's socketpair stdin.
  const child = spawn('sh', ['-c', `cat | ${scriptCommand}`], {
    detached: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BAZFRAME_HOME: join(temporaryRoot, 'packed-tui-home'),
      NO_COLOR: '1'
    }
  });
  let stdout = ''; let stderr = ''; let quitSent = false; let timedOut = false;
  const sendQuit = () => {
    if (quitSent || !stdout.includes('Status: Ready')) return;
    quitSent = true;
    child.stdin.write('q');
    child.stdin.end();
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; sendQuit(); });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessTree(child.pid);
  }, Math.max(0, deadline - Date.now()));
  let status = 1; let runError;
  try {
    status = await new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveResult(signal === null ? (code ?? 1) : 1));
    });
  } catch (error) { runError = error; }
  finally {
    clearTimeout(timeout);
    if (processGroupExists(child.pid)) killProcessTree(child.pid);
    await waitForProcessGroupGone(child.pid, deadline);
  }
  if (processGroupExists(child.pid)) throw new Error(`Packed TUI process group ${child.pid} survived cleanup.`);
  if (runError !== undefined) throw runError;
  return { status: timedOut ? 1 : status, stdout, stderr };
}

function processGroupExists(pid) {
  if (pid === undefined) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function waitForProcessGroupGone(pid, deadline) {
  while (processGroupExists(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setImmediate(resolveWait));
  }
}

function killProcessTree(pid) {
  if (pid === undefined) return;
  const rows = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).stdout
    .trim().split('\n').map((line) => line.trim().split(/\s+/u).map(Number));
  const children = new Map();
  for (const [childPid, parentPid] of rows) {
    const list = children.get(parentPid) ?? [];
    list.push(childPid); children.set(parentPid, list);
  }
  const descendants = [];
  const visit = (parent) => { for (const child of children.get(parent) ?? []) { visit(child); descendants.push(child); } };
  visit(pid);
  for (const target of descendants) try { process.kill(target, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertExists(path) {
  if (!existsSync(path)) throw new Error(`Expected packaged path: ${path}`);
}

function assertMissing(path) {
  if (existsSync(path)) throw new Error(`Expected package to exclude path: ${path}`);
}

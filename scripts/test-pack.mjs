import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
  assertExists(join(packageRoot, 'artifacts', 'pi', 'bazframe.ts'));
  assertExists(join(packageRoot, 'README.md'));
  assertExists(join(packageRoot, 'docs', 'prototype.md'));
  assertExists(join(packageRoot, 'docs', 'design.md'));
  assertExists(join(packageRoot, 'docs', 'pi-adaptive-context-adapter.md'));
  assertExists(join(packageRoot, 'docs', 'pi-adapter-production-design.md'));
  assertExists(join(packageRoot, 'docs', 'research', 'origin-and-rationale.md'));
  assertExists(join(packageRoot, 'docs', 'research', 'prototype-alternatives.md'));
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
  if (manifest.dependencies?.ink !== '7.1.1' || manifest.dependencies?.react !== '19.2.8') {
    throw new Error('Expected exact packaged Ink and React runtime dependencies.');
  }

  const executable = process.platform === 'win32'
    ? join(temporaryRoot, 'node_modules', '.bin', 'bazframe.cmd')
    : join(temporaryRoot, 'node_modules', '.bin', 'bazframe');
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', shell: false });
  if (result.status !== 0 || result.stdout !== 'Bazframe 2 prototype 0.0.0-prototype.0\n') {
    throw new Error(
      `Installed CLI version check failed (${result.status}).\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
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
    const scriptCommand = process.platform === 'darwin'
      ? `script -q /dev/null ${shellQuote(executable)} tui`
      : `script -q -e -c ${shellQuote(`${shellQuote(executable)} tui`)} /dev/null`;
    const packedTui = spawnSync('sh', ['-c', `(sleep 0.5; printf q) | ${scriptCommand}`], {
      encoding: 'utf8',
      shell: false,
      timeout: 8_000,
      env: {
        ...process.env,
        BAZFRAME_HOME: join(temporaryRoot, 'packed-tui-home'),
        SKILLBOOK_LIBRARY: join(temporaryRoot, 'packed-skillbook'),
        NO_COLOR: '1'
      }
    });
    if (
      packedTui.status !== 0
      || !packedTui.stdout.includes('\u001B[?1049h')
      || !packedTui.stdout.includes('\u001B[?1049l')
    ) {
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
  rmSync(temporaryRoot, { recursive: true, force: true });
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

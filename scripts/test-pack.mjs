import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
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
  assertExists(join(packageRoot, 'dist', 'cli.js'));
  assertExists(join(packageRoot, 'README.md'));
  assertExists(join(packageRoot, 'docs', 'prototype.md'));
  assertExists(join(packageRoot, 'docs', 'design.md'));
  assertExists(join(packageRoot, 'docs', 'research', 'origin-and-rationale.md'));
  assertExists(join(packageRoot, 'docs', 'research', 'prototype-alternatives.md'));
  assertExists(join(packageRoot, 'TODO.md'));
  assertExists(join(packageRoot, 'examples', 'profiles', 'focused', 'instructions.md'));
  assertExists(join(packageRoot, 'examples', 'profiles', 'reviewer', 'instructions.md'));
  assertMissing(join(packageRoot, 'src'));
  assertMissing(join(packageRoot, 'test'));
  assertMissing(join(packageRoot, 'scripts'));

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.bin?.bazframe !== './dist/cli.js') {
    throw new Error(`Unexpected packaged bin target: ${manifest.bin?.bazframe}`);
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
} finally {
  if (tarballPath !== undefined && existsSync(tarballPath)) unlinkSync(tarballPath);
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function assertExists(path) {
  if (!existsSync(path)) throw new Error(`Expected packaged path: ${path}`);
}

function assertMissing(path) {
  if (existsSync(path)) throw new Error(`Expected package to exclude path: ${path}`);
}

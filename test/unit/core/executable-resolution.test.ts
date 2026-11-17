import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { executableEnvironmentValue, resolveControlledExecutable, resolvePackageExecutable, resolvePiExecutable, type ExecutableResolutionEffects } from '../../../src/core/executable-resolution.js';

const npmShim = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*';
function fixture(files: string[], shim = npmShim) {
  const probes: string[] = [];
  const effects: ExecutableResolutionEffects = {
    async executable(path) { probes.push(path); return files.includes(path); },
    async canonical(path) { return path; },
    async readShim() { return shim; }
  };
  return { probes, effects, cwd: 'C:\\caller', platform: 'win32' as const, environment: { Path: ';.;C:relative;\\rooted;C:\\fetched;C:\\tools' }, excludedRoots: ['C:\\fetched'] };
}
describe('literal executable resolution', () => {
  // Fixture is npm cmd-shim output stored with LF; exercise the generated CRLF bytes.
  it.each(['dist\\cli.js', 'dist\\bundle\\cli.js'])('translates only the exact generated Pi %s shim, preserving canonical target and selected Node', async (layout) => {
    const current = readFileSync(new URL('../../fixtures/process/pi-bundle.cmd', import.meta.url), 'utf8').replaceAll('\n', '\r\n');
    const shim = current.replace('dist\\bundle\\cli.js', layout);
    const directory = 'C:\\tools with spaces', cli = `${directory}\\node_modules\\@earendil-works\\pi-coding-agent\\${layout}`;
    const options = fixture([`${directory}\\pi.cmd`, 'C:\\tools\\node.exe', cli], shim);
    options.effects.canonical = async path => path === cli ? 'C:\\canonical target\\cli.js' : path;
    expect(await resolvePiExecutable(`${directory}\\pi.cmd`, options)).toEqual({ executable: 'C:\\tools\\node.exe', args: ['C:\\canonical target\\cli.js'] });
    const adjacent = fixture([`${directory}\\pi.cmd`, `${directory}\\node.exe`, cli], shim);
    expect(await resolvePiExecutable(`${directory}\\pi.cmd`, adjacent)).toEqual({ executable: `${directory}\\node.exe`, args: [cli] });
  });
  it.each(['dist\\cli.js', 'dist\\bundle\\cli.js'])('translates the exact dependency-local generated Pi %s shim', async layout => {
    const current = readFileSync(new URL('../../fixtures/process/pi-bundle.cmd', import.meta.url), 'utf8').replaceAll('\n', '\r\n');
    const shim = current.replace('node_modules\\@earendil-works', '..\\@earendil-works').replace('dist\\bundle\\cli.js', layout);
    const cli = `C:\\tools\\node_modules\\bazframe\\node_modules\\@earendil-works\\pi-coding-agent\\${layout}`;
    const launcher = 'C:\\tools\\node_modules\\bazframe\\node_modules\\.bin\\pi.cmd';
    const options = fixture([launcher, 'C:\\tools\\node.exe', cli], shim);
    expect(await resolvePiExecutable(launcher, options)).toEqual({ executable: 'C:\\tools\\node.exe', args: [cli] });
    for (const wrong of [shim + '\necho injected', shim.replace('..\\@earendil-works', '..\\..\\@earendil-works'), shim.replace(layout, 'dist\\other.js')]) {
      await expect(resolvePiExecutable(launcher, fixture([launcher, 'C:\\tools\\node.exe', cli], wrong))).rejects.toMatchObject({ code: 'EXECUTABLE_SHIM_UNSUPPORTED' });
    }
    await expect(resolvePiExecutable(launcher, fixture([launcher, 'C:\\tools\\node.exe'], shim))).rejects.toMatchObject({ code: 'EXECUTABLE_RESOLUTION_FAILED' });
  });
  it.each(['tampered', 'other-target', 'missing-target', 'relative-target', 'relative-node'])('refuses current Pi shim %s without another installation fallback', async variant => {
    let shim = readFileSync(new URL('../../fixtures/process/pi-bundle.cmd', import.meta.url), 'utf8').replaceAll('\n', '\r\n');
    const cli = 'C:\\tools\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js';
    if (variant === 'tampered') shim += '\necho injected';
    if (variant === 'other-target') shim = shim.replace('bundle\\cli.js', 'other\\cli.js');
    const options = fixture(['C:\\tools\\pi.cmd', 'C:\\tools\\node.exe', ...(variant === 'missing-target' ? [] : [cli])], shim);
    options.effects.canonical = async path => (variant === 'relative-target' && path === cli) || (variant === 'relative-node' && path.endsWith('node.exe')) ? 'relative.js' : path;
    await expect(resolvePiExecutable('pi', options)).rejects.toThrow();
  });
  it.each([true, false])('defers the exact Node24 npm prefix launcher until authorization, preferred CLI present=%s', async (present) => {
    const shim = readFileSync(new URL('../../fixtures/process/npm-prefix.cmd', import.meta.url), 'utf8');
    const prefixCli = 'C:\\prefix\\node_modules\\npm\\bin\\npm-cli.js';
    const adjacent = 'C:\\tools\\node_modules\\npm\\bin\\npm-cli.js';
    const options = fixture(['C:\\tools\\npm.cmd', 'C:\\tools\\node.exe', adjacent, 'C:\\tools\\node_modules\\npm\\bin\\npm-prefix.js', ...(present ? [prefixCli] : [])], shim);
    let invoked = false;
    options.effects.runHelper = async (node, args, cwd) => { invoked = true; expect(node).toBe('C:\\tools\\node.exe'); expect(args).toEqual(['C:\\tools\\node_modules\\npm\\bin\\npm-prefix.js']); expect(cwd).toBe(options.cwd); return { status: 0, stdout: 'C:\\prefix\r\n', stderr: '' }; };
    const args = ['run', 'build', '%PATH%', '&', 'a b', '"quoted"'];
    const launch = await resolvePackageExecutable(['npm', ...args], options);
    expect(invoked).toBe(false);
    expect(await launch.afterAuthorization!()).toEqual({ executable: 'C:\\tools\\node.exe', args: [present ? prefixCli : adjacent, ...args] });
    expect(invoked).toBe(true);
  });
  it.each(['failure', 'uncertain', 'contradictory', 'multiple-lines'])('refuses npm prefix helper %s without falling back to another CLI', async (variant) => {
    const shim = readFileSync(new URL('../../fixtures/process/npm-prefix.cmd', import.meta.url), 'utf8');
    const options = fixture(['C:\\tools\\npm.cmd', 'C:\\tools\\node.exe', 'C:\\tools\\node_modules\\npm\\bin\\npm-cli.js', 'C:\\tools\\node_modules\\npm\\bin\\npm-prefix.js'], shim);
    options.effects.runHelper = async () => ({ status: variant === 'failure' ? 1 : 0, stdout: variant === 'multiple-lines' ? 'C:\\one\nC:\\two\n' : 'C:\\prefix\n', stderr: '', ...(variant === 'uncertain' ? { uncertainTermination: true } : {}), ...(variant === 'contradictory' ? { stdoutBytes: Buffer.from('other') } : {}) });
    const launch = await resolvePackageExecutable(['npm', 'run', 'build'], options);
    await expect(launch.afterAuthorization!()).rejects.toThrow();
  });

  it.each(['git', 'gh'])('never searches fetched or implicit cwd helpers for %s', async (command) => {
    const options = fixture([`C:\\fetched\\${command}.exe`, `C:\\caller\\${command}.exe`, `C:\\tools\\${command}.exe`]);
    expect(await resolveControlledExecutable(command, options)).toBe(`C:\\tools\\${command}.exe`);
    expect(options.probes).toEqual([`C:\\tools\\${command}.exe`]);
  });
  it('anchors explicit relative overrides to original caller and rejects drive-relative paths', async () => {
    const options = fixture(['C:\\caller\\bin\\git.exe']);
    expect(await resolveControlledExecutable('.\\bin\\git.exe', options)).toBe('C:\\caller\\bin\\git.exe');
    for (const command of ['C:git.exe', '\\git.exe']) await expect(resolveControlledExecutable(command, options)).rejects.toMatchObject({ code: 'EXECUTABLE_RESOLUTION_FAILED' });
  });
  it('rejects PATH aliases whose canonical executable is fetched', async () => {
    const options = fixture(['C:\\tools\\git.exe']);
    options.effects.canonical = async () => 'C:\\fetched\\git.exe';
    await expect(resolveControlledExecutable('git', options)).rejects.toMatchObject({ code: 'EXECUTABLE_NOT_FOUND' });
  });
  it('handles environment casing deliberately', () => {
    expect(executableEnvironmentValue({ Path: 'a' }, 'PATH', true)).toBe('a');
    expect(() => executableEnvironmentValue({ Path: 'a', PATH: 'b' }, 'PATH', true)).toThrow('Conflicting');
  });
  it('translates only the selected known npm installation and preserves every argument literally', async () => {
    const options = fixture(['C:\\tools\\npm.cmd', 'C:\\tools\\node.exe', 'C:\\tools\\node_modules\\npm\\bin\\npm-cli.js']);
    const args = ['run', 'build', 'a b', '"quoted"', '%PATH%', '&', '|', '$(touch nope)', '\\'];
    expect(await resolvePackageExecutable(['npm', ...args], options)).toEqual({ executable: 'C:\\tools\\node.exe', args: ['C:\\tools\\node_modules\\npm\\bin\\npm-cli.js', ...args] });
  });
  it.each(['@echo malicious\n', npmShim + '\ncall custom.cmd'])('rejects custom npm shim rather than substituting another installation', async (shim) => {
    const options = fixture(['C:\\caller\\npm.cmd', 'C:\\tools\\npm.cmd'], shim);
    await expect(resolvePackageExecutable(['.\\npm.cmd', 'run', 'build'], options)).rejects.toMatchObject({ code: 'EXECUTABLE_SHIM_UNSUPPORTED' });
    expect(options.probes).toEqual(['C:\\caller\\npm.cmd']);
  });
  it('does not execute unknown batch shims or accept npm without its adjacent Node', async () => {
    await expect(resolvePackageExecutable(['build.cmd'], fixture(['C:\\tools\\build.cmd']))).rejects.toMatchObject({ code: 'EXECUTABLE_SHIM_UNSUPPORTED' });
    await expect(resolvePackageExecutable(['npm'], fixture(['C:\\tools\\npm.cmd']))).rejects.toMatchObject({ code: 'EXECUTABLE_RESOLUTION_FAILED' });
  });
});

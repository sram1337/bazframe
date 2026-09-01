import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PACKED_TUI_DEADLINE_MS = 30_000;
const projectRoot = process.cwd();
const sourceManifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const npmExecPath = process.env.npm_execpath;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'bazframe-2-pack-'));
let tarballPath;

if (!npmExecPath) {
  throw new Error('test:pack must run through npm so npm_execpath is available.');
}

try {
  const output = execFileSync(
    process.execPath,
    [npmExecPath, 'pack', '--json', '--pack-destination', temporaryRoot],
    { cwd: projectRoot, encoding: 'utf8' }
  );
  const [{ filename }] = JSON.parse(output);
  tarballPath = resolve(temporaryRoot, filename);

  execFileSync(process.execPath, [npmExecPath, 'init', '-y'], {
    cwd: temporaryRoot,
    stdio: 'ignore'
  });
  execFileSync(
    process.execPath,
    [npmExecPath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    { cwd: temporaryRoot, stdio: 'ignore' }
  );

  const packageRoot = join(temporaryRoot, 'node_modules', sourceManifest.name);
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
  assertExists(join(packageRoot, 'dist', 'profile-portability', 'profile-artifact.js'));
  assertExists(join(packageRoot, 'dist', 'profile-portability', 'profile-artifact-io.js'));
  assertExists(join(packageRoot, 'dist', 'profile-portability', 'profile-artifact-publication.js'));
  assertExists(join(packageRoot, 'dist', 'profile-portability', 'profile-export.js'));
  assertExists(join(packageRoot, 'dist', 'profile-portability', 'profile-import-plan.js'));
  assertExists(join(packageRoot, 'dist', 'profile-portability', 'profile-import-local-library.js'));
  assertExists(join(packageRoot, 'dist', 'profile-portability', 'profile-import-package-build.js'));
  assertExists(join(packageRoot, 'dist', 'profile-portability', 'profile-import-publication.js'));
  assertExists(join(packageRoot, 'dist', 'profile-portability', 'profile-import.js'));
  assertExists(join(packageRoot, 'dist', 'profile-portability', 'profile-portability-policy.js'));
  assertExists(join(packageRoot, 'dist', 'packages', 'package-manifest.js'));
  assertExists(join(packageRoot, 'dist', 'providers', 'managed-git.js'));
  assertExists(join(packageRoot, 'dist', 'providers', 'managed-git-record.js'));
  assertExists(join(packageRoot, 'dist', 'providers', 'managed-git-acquisition-inspection.js'));
  assertExists(join(packageRoot, 'dist', 'providers', 'managed-git-process.js'));
  assertExists(join(packageRoot, 'dist', 'providers', 'managed-git-source.js'));
  assertExists(join(packageRoot, 'dist', 'state', 'bounded-file-read.js'));
  assertExists(join(packageRoot, 'dist', 'state', 'read-only-path-anchor.js'));
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
  assertExists(join(packageRoot, 'CONTRIBUTING.md'));
  assertExists(join(packageRoot, 'docs', 'getting-started.md'));
  assertExists(join(packageRoot, 'docs', 'prototype.md'));
  assertExists(join(packageRoot, 'docs', 'design.md'));
  assertExists(join(packageRoot, 'docs', 'pi-adaptive-context-adapter.md'));
  assertExists(join(packageRoot, 'docs', 'pi-adapter-production-design.md'));
  assertExists(join(packageRoot, 'docs', 'research', 'origin-and-rationale.md'));
  assertExists(join(packageRoot, 'docs', 'research', 'prototype-alternatives.md'));
  assertMissing(join(packageRoot, 'docs', 'reviews'));
  assertExists(join(packageRoot, 'docs', 'releasing.md'));
  assertMissing(join(packageRoot, 'TODO.md'));
  assertExists(join(packageRoot, 'examples', 'setup-fresh-machine.sh'));
  assertExists(join(packageRoot, 'examples', 'profiles', 'focused', 'AGENTS.md'));
  assertExists(join(packageRoot, 'examples', 'profiles', 'reviewer', 'AGENTS.md'));
  assertMissing(join(packageRoot, 'src'));
  assertMissing(join(packageRoot, 'test'));
  assertMissing(join(packageRoot, 'scripts'));

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (
    manifest.name !== sourceManifest.name
    || manifest.version !== sourceManifest.version
    || manifest.private !== sourceManifest.private
    || manifest.license !== sourceManifest.license
  ) {
    throw new Error(`Packed metadata does not match source: ${manifest.name}@${manifest.version}`);
  }
  if (manifest.name !== 'bazframe') {
    throw new Error(`Unexpected package name: ${manifest.name}`);
  }
  if (sourceManifest.license !== undefined && sourceManifest.license !== 'UNLICENSED') {
    assertExists(join(packageRoot, 'LICENSE'));
  }
  if (manifest.bin?.bazframe !== 'dist/cli.js' || manifest.bin?.bzf !== 'dist/cli.js') {
    throw new Error(`Unexpected packaged bin targets: ${JSON.stringify(manifest.bin)}`);
  }
  if (
    manifest.repository?.type !== 'git'
    || manifest.repository?.url !== 'git+https://github.com/sram1337/bazframe.git'
    || manifest.homepage !== 'https://github.com/sram1337/bazframe#readme'
    || manifest.bugs?.url !== 'https://github.com/sram1337/bazframe/issues'
    || manifest.publishConfig?.access !== 'public'
    || manifest.publishConfig?.tag !== 'next'
  ) {
    throw new Error('Packed public-package metadata does not match the pending beta contract.');
  }
  if (
    manifest.dependencies?.['@earendil-works/pi-coding-agent'] !== '>=0.84.4'
    || manifest.dependencies?.ink !== '7.1.1'
    || manifest.dependencies?.react !== '19.2.8'
  ) {
    throw new Error('Expected minimum Pi 0.84.4 and exact Ink/React runtime dependencies.');
  }

  const executable = process.platform === 'win32'
    ? join(temporaryRoot, 'node_modules', '.bin', 'bazframe.cmd')
    : join(temporaryRoot, 'node_modules', '.bin', 'bazframe');
  const packedCatalogHome = join(temporaryRoot, 'packed-catalog-home');
  const registeredSkill = spawnSync(executable, ['skill', 'add', packagedSkill.replace(/\/SKILL\.md$/u, '')], {
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
  if (result.status !== 0 || result.stdout !== `Bazframe ${manifest.version}\n`) {
    throw new Error(
      `Installed CLI version check failed (${result.status}).\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }

  const aliasExecutable = process.platform === 'win32'
    ? join(temporaryRoot, 'node_modules', '.bin', 'bzf.cmd')
    : join(temporaryRoot, 'node_modules', '.bin', 'bzf');
  const aliasResult = spawnSync(aliasExecutable, ['--version'], { encoding: 'utf8', shell: false });
  if (aliasResult.status !== 0 || aliasResult.stdout !== `Bazframe ${manifest.version}\n`) {
    throw new Error(
      `Installed bzf version check failed (${aliasResult.status}).\nstdout: ${aliasResult.stdout}\nstderr: ${aliasResult.stderr}`
    );
  }

  const exportHelp = spawnSync(executable, ['help', 'profile', 'export'], { encoding: 'utf8', shell: false });
  if (exportHelp.status !== 0
    || !exportHelp.stdout.includes('bazframe profile export [--json] <profile> --output <directory>')
    || !exportHelp.stdout.includes('path-free')
    || !exportHelp.stdout.includes('Healthy local direct Skills are omitted')
    || !exportHelp.stdout.includes('full portability remains unavailable')) {
    throw new Error(`Installed profile export help failed (${exportHelp.status}).\nstdout: ${exportHelp.stdout}\nstderr: ${exportHelp.stderr}`);
  }

  const importHelp = spawnSync(executable, ['help', 'profile', 'import'], { encoding: 'utf8', shell: false });
  const expectedImportUsage = 'Usage: bazframe profile import [--json] [--as <profile>] [--map (library|package):<id>=<absolute-source-directory>]... [--dry-run | --yes] <directory>';
  const importUsageLine = importHelp.stdout.split('\n')[0] ?? '';
  if (importHelp.status !== 0
    || importUsageLine !== expectedImportUsage
    || !importHelp.stdout.includes('--map is repeatable for local libraries and packages')
    || !importHelp.stdout.includes('--yes approves every exact revalidated package-build report')
    || !importHelp.stdout.includes('interactive input requires literal y')
    || !importHelp.stdout.includes('Exact healthy package reuse performs no build')
    || !importHelp.stdout.includes('possible nonrollbackable package effects')) {
    throw new Error(`Installed profile import help failed (${importHelp.status}).\nstdout: ${importHelp.stdout}\nstderr: ${importHelp.stderr}`);
  }

  if (process.platform !== 'win32') {
    const canonicalTemporaryRoot = realpathSync(temporaryRoot);
    const packedExportHome = join(canonicalTemporaryRoot, 'packed-export-home');
    const packedExportEnvironment = { ...process.env, BAZFRAME_HOME: packedExportHome, NO_COLOR: '1' };
    runInstalled(executable, ['profile', 'add', 'portable'], packedExportEnvironment, 'Profile lifecycle: added');
    const instructionBytes = 'packed exact instructions\r\n';
    writeFileSync(join(packedExportHome, 'profiles', 'portable', 'AGENTS.md'), instructionBytes);
    const mappedLibraryRoot = join(canonicalTemporaryRoot, 'packed=mapped-sources', 'toolkit');
    const mappedSkillPath = join(mappedLibraryRoot, 'packed-child', 'SKILL.md');
    mkdirSync(join(mappedLibraryRoot, 'packed-child'), { recursive: true });
    writeFileSync(mappedSkillPath, '---\nname: packed-child\ndescription: Packed local mapped library child.\n---\n# Packed child\n');
    runInstalled(executable, ['library', 'add', mappedLibraryRoot], packedExportEnvironment, 'Global library: added');
    runInstalled(executable, ['profile', 'library', 'add', '--profile', 'portable', 'toolkit'], packedExportEnvironment, 'Profile library reference: added');

    const mappedPackageRoot = join(canonicalTemporaryRoot, 'packed=mapped-sources', 'mapped-package');
    const mappedPackageManifestPath = join(mappedPackageRoot, 'bazframe-package.json');
    const mappedPackageBuildPath = join(mappedPackageRoot, 'build.mjs');
    mkdirSync(mappedPackageRoot, { recursive: true });
    writeFileSync(mappedPackageBuildPath, `import{appendFileSync,mkdirSync,writeFileSync}from'node:fs';console.log('mapped-package stdout noise');console.error('mapped-package stderr noise');if(process.env.TEST_BUILD_LOG)appendFileSync(process.env.TEST_BUILD_LOG,'mapped-package\\n');if(process.env.TEST_FAIL_MAPPED_BUILD==='1')process.exit(79);if(process.env.TEST_FORBID_BUILD==='1')process.exit(80);mkdirSync('dist/skills/mapped-child',{recursive:true});writeFileSync('dist/skills/mapped-child/SKILL.md','---\\nname: mapped-child\\ndescription: Packed mapped package child.\\n---\\n# Mapped child\\n');\n`);
    writeFileSync(mappedPackageManifestPath, JSON.stringify({ schemaVersion: 1, build: [process.execPath, 'build.mjs'], artifactRoot: 'dist', skillsRoot: 'skills' }));
    runInstalled(executable, ['package', 'add', mappedPackageRoot], packedExportEnvironment, 'Global package: added');
    runInstalled(executable, ['profile', 'package', 'add', '--profile', 'portable', 'mapped-package'], packedExportEnvironment, 'Profile package reference: added');

    const historicalPackageRemote = join(canonicalTemporaryRoot, 'packed-portability-remotes', 'historical-package');
    mkdirSync(historicalPackageRemote, { recursive: true });
    writeFileSync(join(historicalPackageRemote, '.gitignore'), 'dist/\n');
    writeFileSync(join(historicalPackageRemote, 'build.mjs'), `import{appendFileSync,mkdirSync,writeFileSync}from'node:fs';console.log('historical-package stdout noise');console.error('historical-package stderr noise');if(process.env.TEST_BUILD_LOG)appendFileSync(process.env.TEST_BUILD_LOG,'historical-package\\n');if(process.env.TEST_FORBID_BUILD==='1')process.exit(80);mkdirSync('dist/skills/historical-child',{recursive:true});writeFileSync('dist/skills/historical-child/SKILL.md','---\\nname: historical-child\\ndescription: Packed historical package child.\\n---\\n# Historical child\\n');\n`);
    writeFileSync(join(historicalPackageRemote, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: [process.execPath, 'build.mjs'], artifactRoot: 'dist', skillsRoot: 'skills' }));
    execFileSync('git', ['init', '-b', 'main'], { cwd: historicalPackageRemote, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Pack Test'], { cwd: historicalPackageRemote });
    execFileSync('git', ['config', 'user.email', 'pack@example.test'], { cwd: historicalPackageRemote });
    execFileSync('git', ['add', '.'], { cwd: historicalPackageRemote });
    execFileSync('git', ['commit', '-m', 'historical'], { cwd: historicalPackageRemote, stdio: 'ignore' });
    const historicalPackageRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: historicalPackageRemote, encoding: 'utf8' }).trim();
    const portabilityGitWrapper = join(canonicalTemporaryRoot, 'packed-portability-git-wrapper.mjs');
    writeFileSync(portabilityGitWrapper, `#!/usr/bin/env node
import{appendFileSync}from'node:fs';import{spawnSync}from'node:child_process';const args=process.argv.slice(2);const networkOperations=new Set(['clone','fetch','ls-remote','pull','push']);const networkOperation=args.find(value=>networkOperations.has(value));if(process.env.TEST_FORBID_NETWORK==='1'&&networkOperation){if(process.env.TEST_NETWORK_LOG)appendFileSync(process.env.TEST_NETWORK_LOG,networkOperation+'\\n');process.exit(87);}let original;if(args.includes('clone')){const index=args.findIndex(value=>/^https?:|^ssh:/.test(value));original=args[index];args[index]=process.env.TEST_HISTORICAL_PACKAGE_REMOTE;const protocol=args.indexOf('protocol.file.allow=never');if(protocol>=0)args[protocol]='protocol.file.allow=always';if(process.env.TEST_NETWORK_LOG)appendFileSync(process.env.TEST_NETWORK_LOG,'clone\\n');}const result=spawnSync('git',args,{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status??1);if(original){const destination=args.at(-1);const changed=spawnSync('git',['-C',destination,'remote','set-url','origin',original],{stdio:'inherit',env:process.env});process.exit(changed.status??1);}\n`);
    chmodSync(portabilityGitWrapper, 0o755);
    const portabilityExportEnvironment = { ...packedExportEnvironment, BAZFRAME_GIT_COMMAND: portabilityGitWrapper, BAZFRAME_GH_COMMAND: join(canonicalTemporaryRoot, 'missing-portability-gh'), TEST_HISTORICAL_PACKAGE_REMOTE: historicalPackageRemote };
    runInstalled(executable, ['package', 'add', 'https://example.test/team/historical-package.git', '--yes'], portabilityExportEnvironment, 'Remote Git source package: added');
    runInstalled(executable, ['profile', 'package', 'add', '--profile', 'portable', 'historical-package'], portabilityExportEnvironment, 'Profile package reference: added');
    writeFileSync(join(historicalPackageRemote, 'README.md'), 'new branch head\n');
    execFileSync('git', ['add', '.'], { cwd: historicalPackageRemote });
    execFileSync('git', ['commit', '-m', 'advance'], { cwd: historicalPackageRemote, stdio: 'ignore' });

    const packedExports = join(canonicalTemporaryRoot, 'packed-exports');
    mkdirSync(packedExports);
    const proseOutput = join(packedExports, 'prose');
    const proseExport = runInstalled(executable, ['profile', 'export', 'portable', '--output', proseOutput], packedExportEnvironment, 'Profile export: published');
    if (!proseExport.stderr.includes(`Review ${join(proseOutput, 'profile', 'AGENTS.md')} before sharing`)) {
      throw new Error(`Installed profile export warning was missing.\nstderr: ${proseExport.stderr}`);
    }
    const profileManifestPath = join(proseOutput, 'bazframe-profile.json');
    const profileInstructionsPath = join(proseOutput, 'profile', 'AGENTS.md');
    const profileManifestBytes = readFileSync(profileManifestPath, 'utf8');
    const profileManifest = JSON.parse(profileManifestBytes);
    if (readFileSync(profileInstructionsPath, 'utf8') !== instructionBytes
      || readdirSync(proseOutput).join(',') !== 'bazframe-profile.json,profile'
      || readdirSync(join(proseOutput, 'profile')).join(',') !== 'AGENTS.md'
      || profileManifest.profile.id !== 'portable'
      || JSON.stringify(profileManifest.profile.packages) !== JSON.stringify(['historical-package', 'mapped-package'])
      || profileManifest.resources.length !== 3
      || profileManifest.resources[0]?.kind !== 'library' || profileManifest.resources[0]?.source?.type !== 'localMapping'
      || profileManifest.resources[1]?.kind !== 'package' || profileManifest.resources[1]?.id !== 'historical-package'
      || profileManifest.resources[1]?.source?.type !== 'remoteGit' || profileManifest.resources[1]?.source?.revision !== historicalPackageRevision
      || profileManifest.resources[2]?.kind !== 'package' || profileManifest.resources[2]?.id !== 'mapped-package'
      || profileManifest.resources[2]?.source?.type !== 'localMapping'
      || [mappedLibraryRoot, mappedPackageRoot, historicalPackageRemote, packedExportHome].some((path) => profileManifestBytes.includes(path))
      || ['"root"', '"digest"', '"device"', '"inode"', '"snapshot"'].some((field) => profileManifestBytes.includes(field))) {
      throw new Error('Installed profile export did not publish canonical path-free typed library/package requirements.');
    }
    const jsonOutput = join(packedExports, 'json');
    const jsonExport = spawnSync(executable, ['profile', 'export', '--json', 'portable', '--output', jsonOutput], {
      encoding: 'utf8', shell: false, env: packedExportEnvironment
    });
    const jsonLines = jsonExport.stdout.trim().split('\n');
    const jsonDocument = JSON.parse(jsonExport.stdout);
    const jsonResources = JSON.stringify(jsonDocument.result?.resources);
    if (jsonExport.status !== 0 || jsonExport.stderr !== '' || jsonLines.length !== 1
      || jsonDocument.command !== 'profile.export'
      || jsonDocument.result.outputPath !== jsonOutput
      || jsonDocument.result.instructions.path !== 'profile/AGENTS.md'
      || jsonDocument.result.resources.length !== 3
      || jsonDocument.result.resources[1]?.kind !== 'package'
      || jsonDocument.result.resources[1]?.id !== 'historical-package'
      || jsonDocument.result.resources[1]?.revision !== historicalPackageRevision
      || jsonDocument.result.resources[2]?.kind !== 'package'
      || jsonDocument.result.resources[2]?.sourceType !== 'localMapping'
      || [mappedLibraryRoot, mappedPackageRoot, historicalPackageRemote, packedExportHome].some((path) => jsonResources.includes(path))
      || ['"root"', '"digest"', '"device"', '"inode"', '"snapshot"'].some((field) => jsonResources.includes(field))
      || jsonDocument.diagnostics.at(-1)?.code !== 'PROFILE_EXPORT_REVIEW_INSTRUCTIONS'
      || readFileSync(join(jsonOutput, 'profile', 'AGENTS.md'), 'utf8') !== instructionBytes) {
      throw new Error(`Installed JSON profile export failed (${jsonExport.status}).\nstdout: ${jsonExport.stdout}\nstderr: ${jsonExport.stderr}`);
    }

    const immutableInputs = [proseOutput, profileManifestPath, profileInstructionsPath, mappedLibraryRoot, mappedSkillPath, mappedPackageRoot, mappedPackageManifestPath, mappedPackageBuildPath, historicalPackageRemote];
    const immutableInputObservation = observePhysicalPaths(immutableInputs);
    const packedImportParent = join(canonicalTemporaryRoot, 'packed-import-parent');
    const packedImportHome = join(packedImportParent, 'home');
    mkdirSync(packedImportParent);
    const networkLog = join(canonicalTemporaryRoot, 'packed-local-network.log');
    const buildLog = join(canonicalTemporaryRoot, 'packed-portability-build.log');
    const packedImportEnvironment = {
      ...process.env,
      BAZFRAME_HOME: packedImportHome,
      NO_COLOR: '1',
      BAZFRAME_GIT_COMMAND: portabilityGitWrapper,
      BAZFRAME_GH_COMMAND: join(canonicalTemporaryRoot, 'missing-portability-gh'),
      TEST_HISTORICAL_PACKAGE_REMOTE: historicalPackageRemote,
      TEST_NETWORK_LOG: networkLog,
      TEST_BUILD_LOG: buildLog
    };
    const importMaps = [`library:toolkit=${mappedLibraryRoot}`, `package:mapped-package=${mappedPackageRoot}`];
    const importParentBefore = observeDirectory(packedImportParent);
    const dryImport = spawnSync(executable, ['profile', 'import', '--map', importMaps[0], '--map', importMaps[1], '--dry-run', proseOutput, '--json'], {
      encoding: 'utf8', shell: false, env: packedImportEnvironment
    });
    const dryImportDocument = JSON.parse(dryImport.stdout);
    const dryResources = dryImportDocument.result?.plan?.resources;
    if (dryImport.status !== 0 || dryImport.stderr !== '' || dryImport.stdout.trim().split('\n').length !== 1
      || dryImportDocument.command !== 'profile.import'
      || dryImportDocument.result.mode !== 'dry-run'
      || dryImportDocument.result.plan.profileAction !== 'publish'
      || dryImportDocument.result.plan.blockers.length !== 0
      || dryResources?.length !== 3
      || dryResources[0]?.kind !== 'library' || dryResources[0]?.root !== mappedLibraryRoot || dryResources[0]?.buildRequired !== false
      || dryResources[1]?.kind !== 'package' || dryResources[1]?.id !== 'historical-package' || dryResources[1]?.networkRequired !== true || dryResources[1]?.buildRequired !== true
      || dryResources[2]?.kind !== 'package' || dryResources[2]?.id !== 'mapped-package' || dryResources[2]?.root !== mappedPackageRoot
      || dryResources[2]?.networkRequired !== false || dryResources[2]?.buildRequired !== true
      || dryImportDocument.result.plan.packageBuilds?.total !== 2
      || existsSync(packedImportHome)
      || JSON.stringify(observeDirectory(packedImportParent)) !== JSON.stringify(importParentBefore)
      || JSON.stringify(observePhysicalPaths(immutableInputs)) !== JSON.stringify(immutableInputObservation)
      || existsSync(networkLog) || existsSync(buildLog)) {
      throw new Error(`Installed JSON mapped profile import dry-run failed (${dryImport.status}).\nstdout: ${dryImport.stdout}\nstderr: ${dryImport.stderr}`);
    }

    const declinedHome = join(canonicalTemporaryRoot, 'packed-import-declined-home');
    const declinedImport = spawnSync(executable, ['profile', 'import', '--json', '--map', importMaps[0], '--map', importMaps[1], proseOutput], {
      encoding: 'utf8', shell: false, env: { ...packedImportEnvironment, BAZFRAME_HOME: declinedHome }
    });
    const declinedDocument = JSON.parse(declinedImport.stdout);
    if (declinedImport.status !== 1 || declinedImport.stderr !== '' || declinedImport.stdout.trim().split('\n').length !== 1
      || declinedDocument.error?.code !== 'PROFILE_IMPORT_PACKAGE_BUILD_AUTHORIZATION_REQUIRED'
      || declinedDocument.error?.plan?.packageBuilds?.total !== 2
      || existsSync(declinedHome) || existsSync(networkLog) || existsSync(buildLog)) {
      throw new Error(`Installed noninteractive package import did not decline before acquisition (${declinedImport.status}).\nstdout: ${declinedImport.stdout}\nstderr: ${declinedImport.stderr}`);
    }

    runInstalled(executable, ['profile', 'add', 'active'], packedImportEnvironment, 'Profile lifecycle: added');
    runInstalled(executable, ['profile', 'use', 'active'], packedImportEnvironment, 'Active profile: active');
    const activeSelectionPath = join(packedImportHome, 'active-profile');
    const activeSelectionBefore = observePhysicalPaths([activeSelectionPath]);
    const immutableExecutionInputs = [proseOutput, mappedLibraryRoot, mappedPackageManifestPath, mappedPackageBuildPath, historicalPackageRemote];
    const immutableExecutionInputObservation = observePhysicalPaths(immutableExecutionInputs);
    const executedImport = spawnSync(executable, [
      'profile', 'import', '--yes', '--json',
      '--map', importMaps[0], '--map', importMaps[1], proseOutput
    ], { encoding: 'utf8', shell: false, env: packedImportEnvironment });
    const executedDocument = JSON.parse(executedImport.stdout);
    const executedResult = executedDocument.result;
    const packageBuildReports = executedResult?.packageBuildReports;
    const remotePackageReport = packageBuildReports?.find((report) => report.packageId === 'historical-package');
    const localPackageReport = packageBuildReports?.find((report) => report.packageId === 'mapped-package');
    const remotePackageReportBytes = JSON.stringify(remotePackageReport);
    const allPackageReportBytes = JSON.stringify(packageBuildReports);
    const expectedResourceOutcomes = [
      'library:toolkit:created',
      'package:historical-package:created',
      'package:mapped-package:created'
    ];
    if (executedImport.status !== 0 || executedImport.stdout.trim().split('\n').length !== 1
      || ['mapped-package stdout noise', 'mapped-package stderr noise', 'historical-package stdout noise', 'historical-package stderr noise']
        .some((message) => !executedImport.stderr.includes(message) || executedImport.stdout.includes(message))
      || executedDocument.command !== 'profile.import'
      || executedResult?.mode !== 'executed'
      || executedResult.profileOutcome !== 'published'
      || executedResult.activeSelectionChanged !== false
      || executedResult.resources.map((resource) => `${resource.kind}:${resource.id}:${resource.outcome}`).join(',') !== expectedResourceOutcomes.join(',')
      || packageBuildReports?.length !== 2
      || remotePackageReport?.source?.type !== 'remoteGit'
      || remotePackageReport.source.revision !== historicalPackageRevision
      || remotePackageReport.source.remote !== 'example.test/team/historical-package'
      || remotePackageReport.source.fetchUrl !== 'https://example.test/team/historical-package.git'
      || remotePackageReport.source.branch !== 'main'
      || JSON.stringify(remotePackageReport.argv) !== JSON.stringify([process.execPath, 'build.mjs'])
      || remotePackageReport.manifest?.path !== 'bazframe-package.json'
      || !/^[a-f0-9]{64}$/u.test(remotePackageReport.manifest?.sha256 ?? '')
      || 'candidateRoot' in remotePackageReport || 'cwd' in remotePackageReport
      || localPackageReport?.source?.type !== 'localMapping'
      || localPackageReport.source.root !== mappedPackageRoot
      || localPackageReport.candidateRoot !== mappedPackageRoot || localPackageReport.cwd !== mappedPackageRoot
      || JSON.stringify(localPackageReport.argv) !== JSON.stringify([process.execPath, 'build.mjs'])
      || packageBuildReports.some((report) => report.shell !== false || report.inheritedEnvironment !== true
        || report.authority?.sandboxed !== false || report.warning !== 'Package build side effects are not rollbackable.')
      || [packedImportHome, historicalPackageRemote, packedExportHome].some((path) => remotePackageReportBytes.includes(path))
      || ['device', 'inode', 'snapshot', 'cause', 'stack'].some((field) => allPackageReportBytes.includes(`"${field}"`))
      || JSON.stringify(executedResult.possibleNonrollbackablePackageEffects) !== JSON.stringify(['historical-package', 'mapped-package'])) {
      throw new Error(`Installed JSON package profile import failed (${executedImport.status}).\nstdout: ${executedImport.stdout}\nstderr: ${executedImport.stderr}`);
    }

    const localLibraryRecordPath = join(packedImportHome, 'libraries', 'toolkit.json');
    const localLibraryRecord = JSON.parse(readFileSync(localLibraryRecordPath, 'utf8'));
    const localLibrarySnapshotRoot = join(packedImportHome, 'skill-snapshots', 'sha256', localLibraryRecord.digest);
    const mappedPackageRecordPath = join(packedImportHome, 'packages', 'mapped-package.json');
    const mappedPackageRecord = JSON.parse(readFileSync(mappedPackageRecordPath, 'utf8'));
    const mappedPackageSnapshotRoot = join(packedImportHome, 'skill-snapshots', 'sha256', mappedPackageRecord.digest);
    const historicalPackageRecordPath = join(packedImportHome, 'packages', 'historical-package.json');
    const historicalPackageRecord = JSON.parse(readFileSync(historicalPackageRecordPath, 'utf8'));
    const historicalPackageSnapshotRoot = join(packedImportHome, 'skill-snapshots', 'sha256', historicalPackageRecord.digest);
    const historicalPackageGitRecordPath = join(packedImportHome, 'providers', 'git', 'records', 'package', 'historical-package.json');
    const historicalPackageGitRecord = JSON.parse(readFileSync(historicalPackageGitRecordPath, 'utf8'));
    const importedProfileRoot = join(packedImportHome, 'profiles', 'portable');
    const importedLibraryReferencePath = join(importedProfileRoot, 'libraries', 'toolkit.json');
    const importedHistoricalPackageReferencePath = join(importedProfileRoot, 'packages', 'historical-package.json');
    const importedMappedPackageReferencePath = join(importedProfileRoot, 'packages', 'mapped-package.json');
    if (localLibraryRecord.root !== mappedLibraryRoot
      || mappedPackageRecord.root !== mappedPackageRoot
      || historicalPackageRecord.root !== historicalPackageGitRecord.root
      || historicalPackageGitRecord.revision !== historicalPackageRevision
      || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: historicalPackageGitRecord.root, encoding: 'utf8' }).trim() !== historicalPackageRevision
      || readFileSync(join(localLibrarySnapshotRoot, 'artifact', 'packed-child', 'SKILL.md'), 'utf8') !== readFileSync(mappedSkillPath, 'utf8')
      || !existsSync(join(mappedPackageSnapshotRoot, 'artifact', 'skills', 'mapped-child', 'SKILL.md'))
      || !existsSync(join(historicalPackageSnapshotRoot, 'artifact', 'skills', 'historical-child', 'SKILL.md'))
      || JSON.stringify(JSON.parse(readFileSync(importedLibraryReferencePath, 'utf8'))) !== JSON.stringify({ schemaVersion: 1, library: 'toolkit' })
      || JSON.stringify(JSON.parse(readFileSync(importedHistoricalPackageReferencePath, 'utf8'))) !== JSON.stringify({ schemaVersion: 1, package: 'historical-package' })
      || JSON.stringify(JSON.parse(readFileSync(importedMappedPackageReferencePath, 'utf8'))) !== JSON.stringify({ schemaVersion: 1, package: 'mapped-package' })
      || readFileSync(join(importedProfileRoot, 'AGENTS.md'), 'utf8') !== instructionBytes
      || JSON.stringify(observePhysicalPaths([activeSelectionPath])) !== JSON.stringify(activeSelectionBefore)
      || ['packed-child', 'mapped-child', 'historical-child'].some((id) => existsSync(join(packedImportHome, 'skills', id)) || existsSync(join(importedProfileRoot, 'skills', id)))
      || readFileSync(networkLog, 'utf8') !== 'clone\n'
      || readFileSync(buildLog, 'utf8') !== 'historical-package\nmapped-package\n'
      || JSON.stringify(observePhysicalPaths(immutableExecutionInputs)) !== JSON.stringify(immutableExecutionInputObservation)) {
      throw new Error(`Installed package profile import did not publish exact resources and an inactive profile.\nstdout: ${executedImport.stdout}\nstderr: ${executedImport.stderr}`);
    }

    const immutablePublishedPaths = [
      localLibraryRecordPath, localLibrarySnapshotRoot, mappedPackageRecordPath, mappedPackageSnapshotRoot,
      historicalPackageRecordPath, historicalPackageSnapshotRoot, historicalPackageGitRecordPath, importedProfileRoot
    ];
    const immutablePublishedObservation = observePhysicalPaths(immutablePublishedPaths);
    unlinkSync(networkLog);
    unlinkSync(buildLog);
    const retryImport = spawnSync(executable, [
      '--json', 'profile', 'import', '--map', importMaps[0], '--map', importMaps[1], proseOutput
    ], {
      encoding: 'utf8', shell: false,
      env: { ...packedImportEnvironment, TEST_FORBID_NETWORK: '1', TEST_FORBID_BUILD: '1' }
    });
    const retryDocument = JSON.parse(retryImport.stdout);
    if (retryImport.status !== 0 || retryImport.stderr !== '' || retryImport.stdout.trim().split('\n').length !== 1
      || retryDocument.command !== 'profile.import'
      || retryDocument.result.mode !== 'executed'
      || retryDocument.result.profileOutcome !== 'reused'
      || retryDocument.result.resources.length !== 3
      || retryDocument.result.resources.some((resource) => resource.outcome !== 'reused')
      || retryDocument.result.packageBuildReports.length !== 0
      || retryDocument.result.possibleNonrollbackablePackageEffects.length !== 0
      || retryDocument.result.activeSelectionChanged !== false
      || JSON.stringify(observePhysicalPaths(immutablePublishedPaths)) !== JSON.stringify(immutablePublishedObservation)
      || JSON.stringify(observePhysicalPaths([activeSelectionPath])) !== JSON.stringify(activeSelectionBefore)
      || JSON.stringify(observePhysicalPaths(immutableExecutionInputs)) !== JSON.stringify(immutableExecutionInputObservation)
      || existsSync(networkLog) || existsSync(buildLog)) {
      throw new Error(`Installed JSON package profile import offline retry failed (${retryImport.status}).\nstdout: ${retryImport.stdout}\nstderr: ${retryImport.stderr}`);
    }

    runInstalled(executable, ['profile', 'add', 'empty-portable'], packedExportEnvironment, 'Profile lifecycle: added');
    const emptyInstructionBytes = 'packed empty-resource instructions\n';
    writeFileSync(join(packedExportHome, 'profiles', 'empty-portable', 'AGENTS.md'), emptyInstructionBytes);
    const emptyOutput = join(packedExports, 'empty');
    runInstalled(executable, ['profile', 'export', 'empty-portable', '--output', emptyOutput], packedExportEnvironment, 'Profile export: published');
    const emptyManifest = JSON.parse(readFileSync(join(emptyOutput, 'bazframe-profile.json'), 'utf8'));
    if (emptyManifest.profile.id !== 'empty-portable' || emptyManifest.resources.length !== 0) {
      throw new Error('Installed empty-resource profile export was not empty.');
    }

    const emptyImportParent = join(canonicalTemporaryRoot, 'packed-empty-import-parent');
    const emptyImportHome = join(emptyImportParent, 'home');
    mkdirSync(emptyImportParent);
    const emptyImportEnvironment = { ...packedImportEnvironment, BAZFRAME_HOME: emptyImportHome };
    const emptyParentBefore = observeDirectory(emptyImportParent);
    const emptyDryImport = spawnSync(executable, ['profile', 'import', emptyOutput, '--dry-run', '--json'], {
      encoding: 'utf8', shell: false, env: emptyImportEnvironment
    });
    const emptyDryDocument = JSON.parse(emptyDryImport.stdout);
    if (emptyDryImport.status !== 0 || emptyDryImport.stderr !== '' || emptyDryImport.stdout.trim().split('\n').length !== 1
      || emptyDryDocument.command !== 'profile.import'
      || emptyDryDocument.result?.mode !== 'dry-run'
      || emptyDryDocument.result.plan.profileAction !== 'publish'
      || emptyDryDocument.result.plan.resources.length !== 0
      || existsSync(emptyImportHome)
      || JSON.stringify(observeDirectory(emptyImportParent)) !== JSON.stringify(emptyParentBefore)) {
      throw new Error(`Installed JSON empty-resource profile import dry-run failed (${emptyDryImport.status}).\nstdout: ${emptyDryImport.stdout}\nstderr: ${emptyDryImport.stderr}`);
    }

    runInstalled(executable, ['profile', 'add', 'active'], emptyImportEnvironment, 'Profile lifecycle: added');
    runInstalled(executable, ['profile', 'use', 'active'], emptyImportEnvironment, 'Active profile: active');
    const emptyActivePath = join(emptyImportHome, 'active-profile');
    const emptyActiveBefore = observePhysicalPaths([emptyActivePath]);
    runInstalled(executable, ['profile', 'import', emptyOutput], emptyImportEnvironment, 'Profile import: completed');
    if (readFileSync(join(emptyImportHome, 'profiles', 'empty-portable', 'AGENTS.md'), 'utf8') !== emptyInstructionBytes
      || JSON.stringify(observePhysicalPaths([emptyActivePath])) !== JSON.stringify(emptyActiveBefore)) {
      throw new Error('Installed empty-resource profile import did not publish an inactive exact profile.');
    }
    const emptyRetry = spawnSync(executable, ['--json', 'profile', 'import', emptyOutput], {
      encoding: 'utf8', shell: false, env: emptyImportEnvironment
    });
    const emptyRetryDocument = JSON.parse(emptyRetry.stdout);
    if (emptyRetry.status !== 0 || emptyRetry.stderr !== '' || emptyRetry.stdout.trim().split('\n').length !== 1
      || emptyRetryDocument.command !== 'profile.import'
      || emptyRetryDocument.result?.mode !== 'executed'
      || emptyRetryDocument.result.profileOutcome !== 'reused'
      || emptyRetryDocument.result.resources.length !== 0
      || emptyRetryDocument.result.activeSelectionChanged !== false
      || JSON.stringify(observePhysicalPaths([emptyActivePath])) !== JSON.stringify(emptyActiveBefore)) {
      throw new Error(`Installed JSON empty-resource profile import retry failed (${emptyRetry.status}).\nstdout: ${emptyRetry.stdout}\nstderr: ${emptyRetry.stderr}`);
    }

  }

  const managedPackageHelp = spawnSync(executable, ['help', 'package', 'update'], { encoding: 'utf8', shell: false });
  if (managedPackageHelp.status !== 0
    || !managedPackageHelp.stdout.includes('bazframe package update [--accept-rewrite] [--yes] [--json] <package>')
    || !managedPackageHelp.stdout.includes('--accept-rewrite')
    || !managedPackageHelp.stdout.includes('--yes')) {
    throw new Error(`Installed managed package help failed (${managedPackageHelp.status}).\nstdout: ${managedPackageHelp.stdout}\nstderr: ${managedPackageHelp.stderr}`);
  }

  const packedManagedHome = join(temporaryRoot, 'packed-managed-home');
  const managedMissing = spawnSync(executable, ['package', 'update', 'missing', '--yes'], {
    encoding: 'utf8', shell: false, env: { ...process.env, BAZFRAME_HOME: packedManagedHome, NO_COLOR: '1' }
  });
  if (managedMissing.status !== 1 || !managedMissing.stderr.includes('was not acquired from a remote Git source')) {
    throw new Error(`Installed managed package dispatch failed (${managedMissing.status}).\nstdout: ${managedMissing.stdout}\nstderr: ${managedMissing.stderr}`);
  }

  const packedRemote = join(temporaryRoot, 'packed-managed-remote', 'packed-managed-package');
  mkdirSync(join(packedRemote, 'skills', 'packed-remote-skill'), { recursive: true });
  writeFileSync(join(packedRemote, 'skills', 'packed-remote-skill', 'SKILL.md'), '---\nname: packed-remote-skill\ndescription: Packed remote Git Skill.\n---\n# Packed remote\n');
  writeFileSync(join(packedRemote, '.gitignore'), 'dist/\n');
  writeFileSync(join(packedRemote, 'build.mjs'), "import{cp,rm}from'node:fs/promises';await rm('dist',{recursive:true,force:true});await cp('skills','dist/skills',{recursive:true});\n");
  writeFileSync(join(packedRemote, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: [process.execPath, 'build.mjs'], artifactRoot: 'dist', skillsRoot: 'skills' }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: packedRemote, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Pack Test'], { cwd: packedRemote });
  execFileSync('git', ['config', 'user.email', 'pack@example.test'], { cwd: packedRemote });
  execFileSync('git', ['add', '.'], { cwd: packedRemote });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: packedRemote, stdio: 'ignore' });
  const packedGitWrapper = join(temporaryRoot, 'packed-git-wrapper.mjs');
  writeFileSync(packedGitWrapper, `#!/usr/bin/env node
import{spawnSync}from'node:child_process';const args=process.argv.slice(2);let original;if(args.includes('clone')){if(process.env.TEST_FAIL_CLONE==='1')process.exit(87);const index=args.findIndex(value=>/^https?:|^ssh:/.test(value));original=args[index];args[index]=process.env.TEST_REMOTE;const protocol=args.indexOf('protocol.file.allow=never');if(protocol>=0)args[protocol]='protocol.file.allow=always';}const result=spawnSync('git',args,{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status??1);if(original){const destination=args.at(-1);const changed=spawnSync('git',['-C',destination,'remote','set-url','origin',original],{stdio:'inherit',env:process.env});process.exit(changed.status??1);}
`);
  chmodSync(packedGitWrapper, 0o755);
  const packedManagedEnvironment = { ...process.env, BAZFRAME_HOME: packedManagedHome, NO_COLOR: '1', BAZFRAME_GIT_COMMAND: packedGitWrapper, BAZFRAME_GH_COMMAND: join(temporaryRoot, 'missing-gh'), TEST_REMOTE: packedRemote };
  runInstalled(executable, ['package', 'add', 'https://example.test/team/packed-managed-package.git', '--yes'], packedManagedEnvironment, 'Remote Git source package: added');
  runInstalled(executable, ['package', 'add', 'https://example.test/team/packed-managed-package.git', '--yes'], { ...packedManagedEnvironment, TEST_FAIL_CLONE: '1' }, 'Remote Git source package: current');
  const packedManagedStatus = spawnSync(executable, ['status'], { encoding: 'utf8', shell: false, env: packedManagedEnvironment });
  if (![0, 3].includes(packedManagedStatus.status ?? -1)
    || !packedManagedStatus.stdout.includes('package packed-managed-package: ready; example.test/team/packed-managed-package')) {
    throw new Error(`Installed managed package status failed (${packedManagedStatus.status}).\nstdout: ${packedManagedStatus.stdout}\nstderr: ${packedManagedStatus.stderr}`);
  }

  if (process.platform !== 'win32') {
    const packedImportSkillRemote = join(temporaryRoot, 'packed-import-remotes', 'packed-import-skill');
    const packedImportLibraryRemote = join(temporaryRoot, 'packed-import-remotes', 'packed-import-library');
    mkdirSync(packedImportSkillRemote, { recursive: true });
    writeFileSync(join(packedImportSkillRemote, 'SKILL.md'), '---\nname: packed-import-skill\ndescription: Packed imported Skill.\n---\n# Packed import Skill\n');
    mkdirSync(join(packedImportLibraryRemote, 'packed-child'), { recursive: true });
    writeFileSync(join(packedImportLibraryRemote, 'packed-child', 'SKILL.md'), '---\nname: packed-child\ndescription: Packed library child.\n---\n# Packed child\n');
    for (const remote of [packedImportSkillRemote, packedImportLibraryRemote]) {
      execFileSync('git', ['init', '-b', 'main'], { cwd: remote, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Pack Test'], { cwd: remote });
      execFileSync('git', ['config', 'user.email', 'pack@example.test'], { cwd: remote });
      execFileSync('git', ['add', '.'], { cwd: remote });
      execFileSync('git', ['commit', '-m', 'historical'], { cwd: remote, stdio: 'ignore' });
    }
    const packedImportSkillRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packedImportSkillRemote, encoding: 'utf8' }).trim();
    const packedImportLibraryRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packedImportLibraryRemote, encoding: 'utf8' }).trim();
    for (const remote of [packedImportSkillRemote, packedImportLibraryRemote]) {
      writeFileSync(join(remote, 'README.md'), 'new branch head\n');
      execFileSync('git', ['add', '.'], { cwd: remote });
      execFileSync('git', ['commit', '-m', 'advance'], { cwd: remote, stdio: 'ignore' });
    }
    const packedImportArtifact = join(temporaryRoot, 'packed-import-resource-artifact');
    const packedImportInstructions = 'packed imported instructions\r\n';
    mkdirSync(join(packedImportArtifact, 'profile'), { recursive: true });
    writeFileSync(join(packedImportArtifact, 'profile', 'AGENTS.md'), packedImportInstructions);
    writeFileSync(join(packedImportArtifact, 'bazframe-profile.json'), `${JSON.stringify({
      schemaVersion: 1,
      kind: 'bazframe-profile-export',
      profile: {
        id: 'packed-imported',
        instructions: { path: 'profile/AGENTS.md', sha256: createHash('sha256').update(packedImportInstructions).digest('hex') },
        skills: ['packed-import-skill'],
        omittedLocalSkills: [],
        libraries: ['packed-import-library'],
        packages: []
      },
      resources: [
        { kind: 'skill', id: 'packed-import-skill', source: { type: 'remoteGit', remote: 'example.test/team/packed-import-skill', fetchUrl: 'https://example.test/team/packed-import-skill.git', branch: 'main', revision: packedImportSkillRevision } },
        { kind: 'library', id: 'packed-import-library', source: { type: 'remoteGit', remote: 'example.test/team/packed-import-library', fetchUrl: 'https://example.test/team/packed-import-library.git', branch: 'main', revision: packedImportLibraryRevision } }
      ]
    }, null, 2)}\n`);
    const packedImportGitWrapper = join(temporaryRoot, 'packed-import-git-wrapper.mjs');
    writeFileSync(packedImportGitWrapper, `#!/usr/bin/env node
import{spawnSync}from'node:child_process';const args=process.argv.slice(2);let original;if(args.includes('clone')){if(process.env.TEST_FAIL_CLONE==='1')process.exit(87);const index=args.findIndex(value=>/^https?:|^ssh:/.test(value));original=args[index];args[index]=original.endsWith('/packed-import-skill.git')?process.env.TEST_SKILL_REMOTE:process.env.TEST_LIBRARY_REMOTE;const protocol=args.indexOf('protocol.file.allow=never');if(protocol>=0)args[protocol]='protocol.file.allow=always';}const result=spawnSync('git',args,{stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status??1);if(original){const destination=args.at(-1);const changed=spawnSync('git',['-C',destination,'remote','set-url','origin',original],{stdio:'inherit',env:process.env});process.exit(changed.status??1);}
`);
    chmodSync(packedImportGitWrapper, 0o755);
    const packedResourceImportHome = join(temporaryRoot, 'packed-resource-import-home');
    const packedResourceImportEnvironment = {
      ...process.env,
      BAZFRAME_HOME: packedResourceImportHome,
      NO_COLOR: '1',
      BAZFRAME_GIT_COMMAND: packedImportGitWrapper,
      BAZFRAME_GH_COMMAND: join(temporaryRoot, 'missing-import-gh'),
      TEST_SKILL_REMOTE: packedImportSkillRemote,
      TEST_LIBRARY_REMOTE: packedImportLibraryRemote
    };
    runInstalled(executable, ['profile', 'add', 'active'], packedResourceImportEnvironment, 'Profile lifecycle: added');
    runInstalled(executable, ['profile', 'use', 'active'], packedResourceImportEnvironment, 'Active profile: active');
    const packedResourceActiveBytes = readFileSync(join(packedResourceImportHome, 'active-profile'), 'utf8');
    const packedResourceImport = runInstalled(executable, ['profile', 'import', packedImportArtifact, '--as', 'packed-target'], packedResourceImportEnvironment, 'Profile import: completed');
    const packedSkillRecord = JSON.parse(readFileSync(join(packedResourceImportHome, 'providers', 'git', 'records', 'skill', 'packed-import-skill.json'), 'utf8'));
    const packedLibraryRecord = JSON.parse(readFileSync(join(packedResourceImportHome, 'providers', 'git', 'records', 'library', 'packed-import-library.json'), 'utf8'));
    if (!packedResourceImport.stdout.includes('Destination profile: packed-target')
      || packedSkillRecord.revision !== packedImportSkillRevision
      || packedLibraryRecord.revision !== packedImportLibraryRevision
      || !existsSync(join(packedResourceImportHome, 'profiles', 'packed-target', 'skills', 'packed-import-skill'))
      || existsSync(join(packedResourceImportHome, 'skills', 'packed-child'))
      || readFileSync(join(packedResourceImportHome, 'active-profile'), 'utf8') !== packedResourceActiveBytes) {
      throw new Error(`Installed exact-resource profile import failed.\nstdout: ${packedResourceImport.stdout}\nstderr: ${packedResourceImport.stderr}`);
    }
    const packedResourceRetry = spawnSync(executable, ['profile', 'import', packedImportArtifact, '--as=packed-target', '--json'], {
      encoding: 'utf8', shell: false, env: { ...packedResourceImportEnvironment, TEST_FAIL_CLONE: '1' }
    });
    const packedResourceRetryDocument = JSON.parse(packedResourceRetry.stdout);
    if (packedResourceRetry.status !== 0 || packedResourceRetry.stderr !== ''
      || packedResourceRetryDocument.result.profileOutcome !== 'reused'
      || packedResourceRetryDocument.result.resources.some((resource) => resource.outcome !== 'reused')
      || readFileSync(join(packedResourceImportHome, 'active-profile'), 'utf8') !== packedResourceActiveBytes) {
      throw new Error(`Installed exact-resource profile import retry failed (${packedResourceRetry.status}).\nstdout: ${packedResourceRetry.stdout}\nstderr: ${packedResourceRetry.stderr}`);
    }
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
  runInstalled(executable, ['library', 'add', libraryRoot], collectionEnvironment, 'Global library: added');
  runInstalled(executable, ['profile', 'library', 'add', 'packed-library'], collectionEnvironment, 'Profile library reference: added');
  writeFileSync(join(libraryRoot, 'provider-update.txt'), 'updated\n');
  runInstalled(executable, ['library', 'update', 'packed-library'], collectionEnvironment, 'Global library: updated');
  const fixturePackageRoot = join(temporaryRoot, 'packed-package');
  mkdirSync(fixturePackageRoot, { recursive: true });
  writeFileSync(join(fixturePackageRoot, 'build.mjs'), "import{mkdir,writeFile}from'node:fs/promises';await mkdir('dist/skills/package-skill',{recursive:true});await writeFile('dist/skills/package-skill/SKILL.md','---\\nname: package-skill\\ndescription: Packed package Skill.\\n---\\n# Package\\n');\n");
  writeFileSync(join(fixturePackageRoot, 'bazframe-package.json'), JSON.stringify({ schemaVersion: 1, build: [process.execPath, 'build.mjs'], artifactRoot: 'dist', skillsRoot: 'skills' }));
  runInstalled(executable, ['package', 'add', fixturePackageRoot], collectionEnvironment, 'Global package: added');
  runInstalled(executable, ['profile', 'package', 'add', 'packed-package'], collectionEnvironment, 'Profile package reference: added');
  runInstalled(executable, ['package', 'build', 'packed-package'], collectionEnvironment, 'Global package: built');
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
    || !skillEditorHelp.stdout.includes('edit source input')
    || !skillEditorHelp.stdout.includes('bazframe library update <library>')
    || !skillEditorHelp.stdout.includes('bazframe package build <package>')
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

function observeDirectory(path) {
  return observePhysicalPath(path);
}

function observePhysicalPaths(paths) {
  return paths.map((path) => observePhysicalPath(path));
}

function observePhysicalPath(path) {
  const metadata = lstatSync(path, { bigint: true });
  const observation = {
    path,
    kind: metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : metadata.isSymbolicLink() ? 'symlink' : 'other',
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    mode: metadata.mode.toString(),
    size: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
    ctimeNs: metadata.ctimeNs.toString()
  };
  if (metadata.isFile()) return { ...observation, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  if (!metadata.isDirectory()) return observation;
  return {
    ...observation,
    entries: readdirSync(path).sort().map((name) => observePhysicalPath(join(path, name)))
  };
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
    : `script -q -f -e -c ${shellQuote(`exec ${shellQuote(executable)} tui`)} /dev/null`;
  // The shell pipeline gives BSD script a real pipe rather than Node's socketpair stdin.
  const child = spawn('sh', ['-c', `cat | ${scriptCommand}`], {
    detached: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BAZFRAME_HOME: join(temporaryRoot, 'packed-tui-home'),
      CI: 'false',
      NO_COLOR: '1',
      TERM: 'xterm-256color'
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

import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { basename, join } from 'node:path';
import {
  inspectPiAdapter,
  installPiAdapter,
  uninstallPiAdapter
} from '../adapters/pi/installer.js';
import { buildPiArgs } from '../agents/pi-args.js';
import { childExitStatus, spawnPi } from '../agents/spawn-pi.js';
import { BazframeError } from '../core/errors.js';
import { EXIT_STATUS } from '../core/exit-status.js';
import type { InheritedChildRunner } from '../core/external-editor.js';
import { boundedPathForDisplay, boundedPrefixedTextForDisplay, boundedTextForDisplay, escapeUnsafeDisplayCharacters, stringifyForTerminal } from '../core/safe-text.js';
import { composeInstructions } from '../harness/compose-instructions.js';
import { createTemporaryInstructionFile } from '../harness/temporary-instructions.js';
import { resolveEffectivePolicy } from '../policy/effective-policy.js';
import {
  disableGlobally,
  enableGlobally,
  globalPolicyPath,
  readGlobalPolicy,
  type GlobalPolicy
} from '../policy/global-policy.js';
import {
  addProfile,
  currentProfile,
  duplicateProfile,
  listProfiles,
  removeProfile,
  renameProfile,
  type ProfileDuplicateResult,
  type ProfileLifecycleResult,
  type ProfileRenameResult
} from '../profiles/profile-management.js';
import {
  addActiveProfileLibraryReference, addActiveProfilePackageReference,
  addProfileLibraryReference, addProfilePackageReference,
  removeActiveProfileLibraryReference, removeActiveProfilePackageReference,
  removeProfileLibraryReference, removeProfilePackageReference,
  type ProfileCollectionReferenceResult
} from '../profiles/profile-skill-collection-reference-lifecycle.js';
import {
  addActiveProfileSkill,
  addProfileSkill,
  removeActiveProfileSkill,
  removeProfileSkill,
  type ProfileSkillMembershipResult
} from '../profiles/profile-skill-membership.js';
import {
  loadProfile,
  readActiveProfile,
  resolveBazframeHome,
  selectProfile
} from '../profiles/profile-store.js';
import { editProfileInstructions } from '../profiles/profile-instruction-editor.js';
import { exportProfile, ProfileExportError, type ProfileExportResult } from '../profile-portability/profile-export.js';
import { planProfileImport, type ProfileImportPlan } from '../profile-portability/profile-import-plan.js';
import {
  executeProfileImport,
  ProfileImportBlockedError,
  ProfileImportExecutionError,
  ProfileImportPackageBuildAuthorizationRequiredError,
  type ProfileImportPartialResult,
  type ProfileImportResult
} from '../profile-portability/profile-import.js';
import type { PackageBuildAuthorizationReport } from '../profile-portability/profile-import-package-build.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { findGitRoot } from '../project/git-root.js';
import {
  disableRepository,
  enableRepository,
  listRepositoryProjectStates,
  readRepositoryProjectState
} from '../project/registration-store.js';
import type { RepositoryProjectState } from '../project/registration.js';
import { loadRootRepositoryInstructions } from '../project/repository-instructions.js';
import {
  addDefaultSkill,
  DEFAULT_SKILL_SOURCE_LABEL,
  inspectDefaultSkillCatalog,
  removeDefaultSkill,
  type DefaultSkillCatalogResult
} from '../skills/default-skill-catalog.js';
import { editSkillDefinition } from '../skills/skill-definition-editor.js';
import { packageBuildInterruptionSignal } from '../skill-collections/skill-collection-preparation.js';
import {
  formatSkillCollectionDiagnostic,
  inspectGlobalSkillCollections,
  loadFlatSkillIdentities,
  resolveProfileSkillCollections,
  type GlobalSkillCollectionInspection,
  type ProfileSkillCollectionComposition,
  type SkillCollectionDiagnostic
} from '../skill-collections/skill-collection-resolver.js';
import { captureProfileCollectionReferenceBulkIndex } from '../profiles/profile-skill-collection-reference.js';
import { addLibrary, addPackage, buildPackage, removeLibrary, removePackage, updateLibrary, type SkillCollectionLifecycleResult } from '../skill-collections/skill-collection-lifecycle.js';
import { collectionKey, idForRecord, kindForRecord, skillsRootForRecord, type SkillCollectionKind } from '../skill-collections/skill-collection-store.js';
import { buildStatus, inspectStatus, statusExitStatus } from '../status/status.js';
import {
  addManagedGitLibrary, addManagedGitPackage, addManagedGitSkill, buildManagedGitPackage,
  isManagedGitResource, isManagedGitSource, removeManagedGitLibrary, removeManagedGitPackage,
  removeManagedGitSkill, updateManagedGitLibrary, updateManagedGitPackage, updateManagedGitSkill,
  type ManagedGitBuildAuthorization, type ManagedGitLifecycleResult
} from '../providers/managed-git.js';
import {
  colorizeHelp,
  colorizeStatus,
  createCliColors,
  shouldUseColor,
  type CliColors
} from './color.js';
import {
  ADAPTER_HELP,
  ADD_HELP,
  GLOBAL_HELP,
  PI_HELP,
  PROFILE_ADD_HELP,
  PROFILE_CURRENT_HELP,
  PROFILE_DUPLICATE_HELP,
  PROFILE_EDIT_HELP,
  PROFILE_EXPORT_HELP,
  PROFILE_IMPORT_HELP,
  PROFILE_HELP,
  PROFILE_LIST_HELP,
  PROFILE_REMOVE_HELP,
  PROFILE_RENAME_HELP,
  PROFILE_SKILLS_ADD_HELP,
  PROFILE_SKILLS_HELP,
  PROFILE_SKILLS_REMOVE_HELP,
  PROFILE_LIBRARIES_ADD_HELP, PROFILE_LIBRARIES_HELP, PROFILE_LIBRARIES_REMOVE_HELP,
  PROFILE_PACKAGES_ADD_HELP, PROFILE_PACKAGES_HELP, PROFILE_PACKAGES_REMOVE_HELP,
  LIBRARIES_ADD_HELP, LIBRARIES_HELP, LIBRARIES_REMOVE_HELP, LIBRARIES_UPDATE_HELP,
  PACKAGES_ADD_HELP, PACKAGES_BUILD_HELP, PACKAGES_UPDATE_HELP, PACKAGES_HELP, PACKAGES_REMOVE_HELP,
  PROFILE_USE_HELP,
  PROJECT_HELP,
  REMOVE_HELP,
  ROOT_HELP,
  SKILL_EDIT_HELP,
  SKILL_UPDATE_HELP,
  SKILLS_HELP,
  STATUS_HELP,
  TUI_HELP,
  VERSION
} from './help.js';
import { parseArgv, type Command, type HelpTopic } from './parse-argv.js';
import {
  globalCollectionsResult,
  profileCollectionsResult,
  profileExportResult,
  profileImportDryRunResult,
  profileImportExecutionResult,
  profileListResult,
  projectListResult,
  statusResult,
  type ProtocolDiagnostic
} from './command-results.js';
import { cliError, commandId, errorDocument, inferredCommandId, serializeJsonDocument, successDocument } from './json-protocol.js';

export interface CliDependencies {
  cwd?: () => string;
  environment?: NodeJS.ProcessEnv;
  temporaryRoot?: string;
  piExecutable?: string;
  userHome?: string;
  adapterArtifactUrl?: URL;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  stdinIsTty?: boolean;
  stdoutIsTty?: boolean;
  stderrIsTty?: boolean;
  terminateProcess?: (status: number) => void;
  editorChildRunner?: InheritedChildRunner;
  confirmManagedGitPackageBuild?: (details: ManagedGitBuildAuthorization) => boolean | Promise<boolean>;
  confirmProfileImportPackageBuild?: (report: PackageBuildAuthorizationReport) => boolean | Promise<boolean>;
  /** Internal deterministic CLI test seams; production dispatch uses the portability services. */
  planProfileImport?: typeof planProfileImport;
  executeProfileImport?: typeof executeProfileImport;
  /** Internal transport seams; callers select these through argv --json. */
  jsonMode?: boolean;
  captureResult?: (result: Record<string, unknown>) => void;
  captureDiagnostic?: (diagnostic: ProtocolDiagnostic) => void;
  launchTui?: (options: {
    bazframeHome: string;
    bazframeVersion: string;
    cwd: string;
    environment: NodeJS.ProcessEnv;
    userHome?: string;
    adapterArtifactUrl?: URL;
    stdin: NodeJS.ReadStream;
    stdout: NodeJS.WriteStream;
    stderr: NodeJS.WriteStream;
    terminateProcess: (status: number) => void;
  }) => Promise<number>;
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {}
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  const environment = dependencies.environment ?? process.env;
  const stdoutColors = createCliColors(shouldUseColor(
    environment,
    dependencies.stdoutIsTty ?? process.stdout.isTTY === true
  ));
  const stderrColors = createCliColors(shouldUseColor(
    environment,
    dependencies.stderrIsTty ?? process.stderr.isTTY === true
  ));
  const parsed = parseArgv(argv);
  const jsonMode = 'json' in parsed && parsed.json === true;

  if (parsed.kind === 'help') {
    writeStdout(colorizeHelp(helpFor(parsed.topic), stdoutColors));
    return EXIT_STATUS.success;
  }
  if (parsed.kind === 'version') {
    writeStdout(`Bazframe ${VERSION}\n`);
    return EXIT_STATUS.success;
  }
  if (parsed.kind === 'usage-error') {
    if (jsonMode) {
      writeStdout(serializeJsonDocument(errorDocument(
        inferredCommandId(argv),
        cliError(parsed.code ?? 'CLI_USAGE', parsed.message, parsed.topic)
      )));
    } else {
      writeStderr(
        `${stderrColors.error('error:')} ${parsed.message}\n\n${colorizeHelp(helpFor(parsed.topic), stderrColors)}`
      );
    }
    return EXIT_STATUS.usage;
  }

  if (jsonMode) {
    const id = commandId(parsed.command);
    let result: Record<string, unknown> | undefined;
    const diagnostics: ProtocolDiagnostic[] = [];
    try {
      if (parsed.command.name === 'packages-add' && isManagedGitSource(parsed.command.root) && !parsed.command.yes) {
        throw new BazframeError('MANAGED_GIT_BUILD_CONFIRMATION_REQUIRED', 'Package acquisition from a remote Git source in JSON mode requires --yes.');
      }
      if (parsed.command.name === 'packages-update' && !parsed.command.yes) {
        throw new BazframeError('MANAGED_GIT_BUILD_CONFIRMATION_REQUIRED', 'Package update from a remote Git source in JSON mode requires --yes.');
      }
      if (parsed.command.name === 'status') {
        const bazframeHome = resolveBazframeHome(environment, dependencies.userHome);
        const inspection = await inspectStatus({
          bazframeHome, bazframeVersion: VERSION, environment,
          cwd: (dependencies.cwd ?? process.cwd)(),
          ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
          ...(dependencies.adapterArtifactUrl === undefined ? {} : { artifactUrl: dependencies.adapterArtifactUrl })
        });
        const exitStatus = statusExitStatus(inspection);
        writeStdout(serializeJsonDocument(successDocument(id, statusResult(
          inspection,
          exitStatus === EXIT_STATUS.success ? 'ready' : 'attention'
        ))));
        return exitStatus;
      }
      const status = await runCommand(
        parsed.command,
        { ...dependencies, jsonMode: true, captureResult: (value) => { result = value; }, captureDiagnostic: (value) => { diagnostics.push(value); } },
        () => undefined,
        () => undefined,
        createCliColors(false),
        createCliColors(false)
      );
      if (result === undefined) throw new BazframeError('CLI_RESULT_MISSING', `No structured result was produced for ${id}.`);
      writeStdout(serializeJsonDocument(successDocument(id, result, diagnostics)));
      return status;
    } catch (error) {
      if (parsed.command.name === 'profile-import') diagnostics.push(...profileImportFailureDiagnostics(error));
      writeStdout(serializeJsonDocument(errorDocument(id, error, diagnostics)));
      return interruptionExitStatus(error) ?? EXIT_STATUS.failure;
    }
  }

  try {
    return await runCommand(parsed.command, dependencies, writeStdout, writeStderr, stdoutColors, stderrColors);
  } catch (error) {
    const message = parsed.command.name === 'profile-export'
      ? formatProfileExportFailure(error)
      : parsed.command.name === 'profile-import'
        ? formatProfileImportFailure(error)
        : error instanceof Error ? error.message : String(error);
    writeStderr(`${stderrColors.error('error:')} ${message}\n`);
    return interruptionExitStatus(error) ?? EXIT_STATUS.failure;
  }
}

function interruptionExitStatus(error: unknown): number | undefined {
  const signal = packageBuildInterruptionSignal(error);
  return signal === undefined ? undefined : childExitStatus({ exitCode: null, signal });
}

async function runCommand(
  command: Command,
  dependencies: CliDependencies,
  writeStdout: (text: string) => void,
  writeStderr: (text: string) => void,
  stdoutColors: CliColors,
  stderrColors: CliColors
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  if (command.name === 'tui') {
    const stdinIsTty = dependencies.stdinIsTty ?? process.stdin.isTTY === true;
    const stdoutIsTty = dependencies.stdoutIsTty ?? process.stdout.isTTY === true;
    if (!stdinIsTty || !stdoutIsTty) {
      writeStderr(
        'error: `bazframe tui` requires interactive stdin and stdout. Use `bazframe profile list` and `bazframe skill list` in non-interactive environments.\n'
      );
      return EXIT_STATUS.failure;
    }
    const launchTui = dependencies.launchTui ?? (async (options) => {
      const { runTui } = await import('../tui/run-tui.js');
      return runTui(options);
    });
    return launchTui({
      bazframeHome: resolveBazframeHome(environment, dependencies.userHome),
      bazframeVersion: VERSION,
      cwd: (dependencies.cwd ?? process.cwd)(),
      environment,
      ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
      ...(dependencies.adapterArtifactUrl === undefined
        ? {}
        : { adapterArtifactUrl: dependencies.adapterArtifactUrl }),
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      terminateProcess: dependencies.terminateProcess ?? ((status) => process.exit(status))
    });
  }

  const bazframeHome = resolveBazframeHome(environment, dependencies.userHome);
  if (command.name === 'adapters-overview') {
    const adapter = await inspectPiAdapter({
      bazframeHome,
      bazframeVersion: VERSION,
      environment,
      ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
      ...(dependencies.adapterArtifactUrl === undefined
        ? {}
        : { artifactUrl: dependencies.adapterArtifactUrl })
    });
    captureResult(dependencies,{adapters:[{id:'pi',state:adapter.state,targetPath:adapter.targetPath}]});
    writeStdout(formatAdaptersOverview(adapter.state, adapter.targetPath, stdoutColors));
    return EXIT_STATUS.success;
  }
  if (command.name === 'adapter-install-pi') {
    const result = await installPiAdapter({
      bazframeHome,
      bazframeVersion: VERSION,
      environment,
      ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
      ...(dependencies.adapterArtifactUrl === undefined
        ? {}
        : { artifactUrl: dependencies.adapterArtifactUrl })
    }, command.force);
    captureResult(dependencies,{action:result.action,adapterId:'pi',targetPath:result.targetPath,manifestPath:result.manifestPath});
    writeStdout([
      `Pi adapter: ${result.action}`,
      `Extension: ${result.targetPath}`,
      `Ownership manifest: ${result.manifestPath}`,
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }
  if (command.name === 'adapter-uninstall-pi') {
    const result = await uninstallPiAdapter({
      bazframeHome,
      bazframeVersion: VERSION,
      environment,
      ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
      ...(dependencies.adapterArtifactUrl === undefined
        ? {}
        : { artifactUrl: dependencies.adapterArtifactUrl })
    });
    captureResult(dependencies,{action:result.action,adapterId:'pi',targetPath:result.targetPath});
    writeStdout([
      `Pi adapter: ${result.action}`,
      `Extension: ${result.targetPath}`,
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profiles-overview') {
    const result = await listProfiles(bazframeHome);
    let activeProfile: string | undefined;
    try {
      activeProfile = await currentProfile(bazframeHome);
    } catch (error) {
      if (!(error instanceof BazframeError && error.code === 'NO_ACTIVE_PROFILE')) throw error;
    }
    captureResult(dependencies,profileListResult(result.profileIds,activeProfile));
    writeStdout(formatProfilesOverview(result.profileIds, activeProfile, stdoutColors));
    for (const diagnostic of result.diagnostics) reportWarning(dependencies,writeStderr,stderrColors,'PROFILE_ENTRY_INVALID',diagnostic);
    return EXIT_STATUS.success;
  }
  if (command.name === 'skills-overview') {
    const result = await inspectDefaultSkillCatalog(bazframeHome);
    captureResult(dependencies,{catalogRoot:result.root,registrations:result.registrations.map((item)=>({id:item.id,target:item.target}))});
    writeStdout(formatSkillsOverview(result.root, result.registrations, stdoutColors));
    for (const diagnostic of result.diagnostics) reportWarning(dependencies,writeStderr,stderrColors,'SKILL_REGISTRATION_INVALID',diagnostic);
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-skills-overview') {
    const profileId = await readActiveProfile(bazframeHome);
    const profile = await loadProfile(bazframeHome, profileId);
    const skillIds=profile.skillDirectories.map((directory) => basename(directory));
    captureResult(dependencies,{profileId,skills:skillIds.map((id)=>({id}))});
    writeStdout(formatProfileSkillsOverview(profileId,skillIds,stdoutColors));
    return EXIT_STATUS.success;
  }
  if (command.name === 'libraries-overview' || command.name === 'packages-overview') {
    const kind: SkillCollectionKind = command.name === 'libraries-overview' ? 'library' : 'package';
    const inspection = await inspectGlobalSkillCollections(bazframeHome);
    const referenceIndex = await captureProfileCollectionReferenceBulkIndex(bazframeHome);
    const referenceCounts = new Map<string, number | 'unknown'>();
    for (const item of inspection.collections) {
      const key = collectionKey(kindForRecord(item.record), idForRecord(item.record));
      referenceCounts.set(key, referenceIndex.diagnostics.length > 0 ? 'unknown' : (referenceIndex.profileIdsByCollection.get(key)?.length ?? 0));
    }
    captureResult(dependencies,globalCollectionsResult(kind,inspection,referenceCounts,referenceIndex.diagnostics));
    writeStdout(formatCollectionsOverview(kind, inspection, referenceCounts, referenceIndex.diagnostics, stdoutColors));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-libraries-overview' || command.name === 'profile-packages-overview') {
    const kind: SkillCollectionKind = command.name === 'profile-libraries-overview' ? 'library' : 'package';
    const profileId = await readActiveProfile(bazframeHome);
    const profile = await loadProfile(bazframeHome, profileId);
    const composition = await resolveProfileSkillCollections(profile.directory, loadFlatSkillIdentities(profile.skillDirectories));
    captureResult(dependencies,profileCollectionsResult(profileId,kind,composition));
    writeStdout(formatProfileCollectionsOverview(profileId, kind, composition, stdoutColors));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-export') {
    const result = await exportProfile({
      bazframeHome,
      profileId: command.profileId,
      outputDirectory: command.outputDirectory,
      environment
    });
    try {
      captureResult(dependencies, profileExportResult(result));
      writeStdout(formatProfileExport(result));
      for (const skillId of result.omittedLocalSkills) {
        reportWarning(
          dependencies,
          writeStderr,
          stderrColors,
          'PROFILE_EXPORT_LOCAL_SKILL_OMITTED',
          `Local Skill ${escapeUnsafeDisplayCharacters(skillId)} was omitted from the export and recorded in omittedLocalSkills.`
        );
      }
      reportWarning(
        dependencies,
        writeStderr,
        stderrColors,
        'PROFILE_EXPORT_REVIEW_INSTRUCTIONS',
        profileExportReviewDiagnostic(result.outputPath)
      );
      return EXIT_STATUS.success;
    } catch {
      throw new ProfileExportError('published', result.outputPath);
    }
  }
  if (command.name === 'profile-import') {
    if (command.dryRun) {
      const planning = await (dependencies.planProfileImport ?? planProfileImport)({
        bazframeHome,
        artifactDirectory: command.artifactDirectory,
        ...(command.destinationProfileId === undefined ? {} : { destinationProfileId: command.destinationProfileId }),
        mappings: command.mappings.map((mapping) => ({ ...mapping })),
        environment
      });
      captureResult(dependencies, profileImportDryRunResult(planning.plan));
      writeStdout(formatProfileImportPlan(planning.plan, 'dry-run'));
      return EXIT_STATUS.success;
    }
    const interactive = dependencies.jsonMode !== true
      && (dependencies.stdinIsTty ?? process.stdin.isTTY === true)
      && (dependencies.stdoutIsTty ?? process.stdout.isTTY === true);
    const result = await (dependencies.executeProfileImport ?? executeProfileImport)({
      bazframeHome,
      artifactDirectory: command.artifactDirectory,
      ...(command.destinationProfileId === undefined ? {} : { destinationProfileId: command.destinationProfileId }),
      mappings: command.mappings.map((mapping) => ({ ...mapping })),
      environment,
      ...(dependencies.jsonMode === true ? { childOutputPolicy: 'stdout-and-stderr-to-parent-stderr' as const } : {}),
      reportPlan: async (plan) => {
        if (dependencies.jsonMode !== true) writeStdout(formatProfileImportPlan(plan, 'execute'));
        const requiresBuild = plan.blockers.length === 0 && plan.profileAction !== 'blocked'
          && plan.resources.some((resource) => resource.action === 'create' && resource.buildRequired);
        if (requiresBuild && !command.yes && !interactive) {
          throw new ProfileImportPackageBuildAuthorizationRequiredError(plan);
        }
      },
      authorizePackageBuild: async (report) => {
        if (dependencies.jsonMode !== true) writeStdout(formatProfileImportPackageBuildAuthorization(report));
        if (command.yes) return true;
        return (dependencies.confirmProfileImportPackageBuild
          ?? (() => confirmProfileImportPackageBuild()))(report);
      }
    });
    try {
      captureResult(dependencies, profileImportExecutionResult(result));
      writeStdout(formatProfileImportSuccess(result));
    } catch (cause) {
      throw new ProfileImportExecutionError(result, cause);
    }
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-use') {
    const profile = await selectProfile(bazframeHome, command.profileId);
    captureResult(dependencies,{action:'selected',profileId:profile.id,directory:profile.directory});
    writeStdout([
      `Active profile: ${profile.id}`,
      `Profile directory: ${profile.directory}`,
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-edit') {
    const result = await editProfileInstructions({
      bazframeHome,
      profileId: command.profileId,
      environment,
      ...(dependencies.editorChildRunner === undefined
        ? {}
        : { childRunner: dependencies.editorChildRunner })
    });
    return childExitStatus(result);
  }
  if (command.name === 'skill-edit') {
    const result = await editSkillDefinition({
      bazframeHome,
      skillId: command.skillId,
      environment,
      ...(dependencies.editorChildRunner === undefined
        ? {}
        : { childRunner: dependencies.editorChildRunner })
    });
    return childExitStatus(result);
  }
  if (command.name === 'skill-update') {
    const result = await updateManagedGitSkill({
      bazframeHome,
      environment,
      acceptRewrite: command.acceptRewrite
    }, command.skillId);
    captureResult(dependencies,managedGitResult(result));
    writeStdout(formatManagedGitLifecycleResult(result));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-add') {
    const result=await addProfile(bazframeHome,command.profileId);captureResult(dependencies,{action:result.action,profileId:result.profileId,directory:result.directory});writeStdout(formatProfileLifecycle(result));return EXIT_STATUS.success;
  }
  if (command.name === 'profile-duplicate') {
    const result=await duplicateProfile(bazframeHome,command.sourceProfileId,command.profileId);captureResult(dependencies,{action:result.action,sourceProfileId:result.sourceProfileId,profileId:result.profileId,directory:result.directory,activeSelectionUpdated:false});writeStdout(formatProfileDuplicate(result));return EXIT_STATUS.success;
  }
  if (command.name === 'profile-remove') {
    const result=await removeProfile(bazframeHome,command.profileId,command.force);captureResult(dependencies,{action:result.action,profileId:result.profileId,directory:result.directory});writeStdout(formatProfileLifecycle(result));return EXIT_STATUS.success;
  }
  if (command.name === 'profile-rename') {
    const result=await renameProfile(bazframeHome,command.previousProfileId,command.profileId);captureResult(dependencies,{action:result.action,previousProfileId:result.previousProfileId,profileId:result.profileId,directory:result.directory,activeSelectionUpdated:result.activeSelectionUpdated});writeStdout(formatProfileRename(result));return EXIT_STATUS.success;
  }
  if (command.name === 'profile-list') {
    const result = await listProfiles(bazframeHome);
    let activeProfile: string | undefined;
    try { activeProfile = await currentProfile(bazframeHome); }
    catch (error) { if (!(error instanceof BazframeError && error.code === 'NO_ACTIVE_PROFILE')) throw error; }
    captureResult(dependencies,profileListResult(result.profileIds,activeProfile));
    writeStdout(formatProfilesOverview(result.profileIds, activeProfile, stdoutColors));
    for (const diagnostic of result.diagnostics) reportWarning(dependencies,writeStderr,stderrColors,'PROFILE_ENTRY_INVALID',diagnostic);
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-current') {
    const profileId=await currentProfile(bazframeHome);captureResult(dependencies,{profileId});
    writeStdout(`${profileId}\n`);
    return EXIT_STATUS.success;
  }
  if (command.name === 'libraries-add' || command.name === 'libraries-update' || command.name === 'libraries-remove' || command.name === 'packages-add' || command.name === 'packages-build' || command.name === 'packages-update' || command.name === 'packages-remove') {
    const options = {
      bazframeHome,
      environment,
      ...(dependencies.jsonMode === true ? { childOutputPolicy: 'stdout-and-stderr-to-parent-stderr' as const } : {})
    };
    if (command.name === 'libraries-add' && isManagedGitSource(command.root)) {
      const result=await addManagedGitLibrary(options,command.root);captureResult(dependencies,managedGitResult(result));writeStdout(formatManagedGitLifecycleResult(result));return EXIT_STATUS.success;
    }
    if (command.name === 'packages-add' && isManagedGitSource(command.root)) {
      const result=await addManagedGitPackage({
        ...options,
        yes: command.yes,
        ...(dependencies.jsonMode === true ? {} : {
          reportPackageBuild: (details: ManagedGitBuildAuthorization) => writeStdout(formatManagedPackageBuildAuthorization(details)),
          confirmPackageBuild: dependencies.confirmManagedGitPackageBuild ?? (() => confirmManagedPackageBuild(dependencies))
        })
      }, command.root);captureResult(dependencies,managedGitResult(result));writeStdout(formatManagedGitLifecycleResult(result));return EXIT_STATUS.success;
    }
    if (command.name === 'libraries-update' && await isManagedGitResource({ bazframeHome }, 'library', command.id)) {
      const result=await updateManagedGitLibrary({...options,acceptRewrite:command.acceptRewrite},command.id);captureResult(dependencies,managedGitResult(result));writeStdout(formatManagedGitLifecycleResult(result));return EXIT_STATUS.success;
    }
    if (command.name === 'packages-update') {
      const result=await updateManagedGitPackage({
        ...options,
        acceptRewrite: command.acceptRewrite,
        yes: command.yes,
        ...(dependencies.jsonMode === true ? {} : {
          reportPackageBuild: (details: ManagedGitBuildAuthorization) => writeStdout(formatManagedPackageBuildAuthorization(details)),
          confirmPackageBuild: dependencies.confirmManagedGitPackageBuild ?? (() => confirmManagedPackageBuild(dependencies))
        })
      }, command.id);captureResult(dependencies,managedGitResult(result));writeStdout(formatManagedGitLifecycleResult(result));return EXIT_STATUS.success;
    }
    if (command.name === 'libraries-remove' && await isManagedGitResource({ bazframeHome }, 'library', command.id)) {
      const result=await removeManagedGitLibrary(options,command.id);captureResult(dependencies,managedGitResult(result));writeStdout(formatManagedGitLifecycleResult(result));return EXIT_STATUS.success;
    }
    if (command.name === 'packages-remove' && await isManagedGitResource({ bazframeHome }, 'package', command.id)) {
      const result=await removeManagedGitPackage(options,command.id);captureResult(dependencies,managedGitResult(result));writeStdout(formatManagedGitLifecycleResult(result));return EXIT_STATUS.success;
    }
    let result: SkillCollectionLifecycleResult;
    let managedProvider=false;
    switch (command.name) {
      case 'libraries-add': result = await addLibrary(options, command.root); break;
      case 'libraries-update':
        if (command.acceptRewrite) throw new BazframeError('MANAGED_GIT_OPTION_INVALID', '--accept-rewrite applies only to libraries acquired from remote Git sources.');
        result = await updateLibrary(options, command.id); break;
      case 'libraries-remove': result = await removeLibrary(options, command.id); break;
      case 'packages-add': result = await addPackage(options, command.root); break;
      case 'packages-build':
        managedProvider=await isManagedGitResource({bazframeHome},'package',command.id);
        result=managedProvider?await buildManagedGitPackage(options,command.id):await buildPackage(options,command.id);
        break;
      case 'packages-remove': result = await removePackage(options, command.id); break;
      default: throw new Error('unreachable package update dispatch');
    }
    captureResult(dependencies,{...collectionLifecycleResult(result),sourceType:managedProvider?'remoteGit':'local'});
    writeStdout(formatCollectionLifecycleResult(result));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-libraries-add' || command.name === 'profile-libraries-remove' || command.name === 'profile-packages-add' || command.name === 'profile-packages-remove') {
    const options = { bazframeHome };
    const explicit = command.profileId !== undefined;
    let result: ProfileCollectionReferenceResult;
    if (command.name === 'profile-libraries-add') result = explicit ? await addProfileLibraryReference(options, command.profileId!, command.id) : await addActiveProfileLibraryReference(options, command.id);
    else if (command.name === 'profile-libraries-remove') result = explicit ? await removeProfileLibraryReference(options, command.profileId!, command.id) : await removeActiveProfileLibraryReference(options, command.id);
    else if (command.name === 'profile-packages-add') result = explicit ? await addProfilePackageReference(options, command.profileId!, command.id) : await addActiveProfilePackageReference(options, command.id);
    else result = explicit ? await removeProfilePackageReference(options, command.profileId!, command.id) : await removeActiveProfilePackageReference(options, command.id);
    captureResult(dependencies,collectionReferenceResult(result,explicit));
    writeStdout(formatCollectionReferenceResult(result, explicit));
    return EXIT_STATUS.success;
  }
  if (command.name === 'default-skill-add' || command.name === 'default-skill-remove') {
    if (command.name === 'default-skill-add' && isManagedGitSource(command.skillRoot)) {
      const result=await addManagedGitSkill({bazframeHome,environment},command.skillRoot);captureResult(dependencies,managedGitResult(result));writeStdout(formatManagedGitLifecycleResult(result));return EXIT_STATUS.success;
    }
    if (command.name === 'default-skill-remove' && await isManagedGitResource({ bazframeHome }, 'skill', command.skillId)) {
      const result=await removeManagedGitSkill({bazframeHome,environment},command.skillId);captureResult(dependencies,managedGitResult(result));writeStdout(formatManagedGitLifecycleResult(result));return EXIT_STATUS.success;
    }
    const result = command.name === 'default-skill-add' ? await addDefaultSkill(bazframeHome,command.skillRoot) : await removeDefaultSkill(bazframeHome,command.skillId);
    captureResult(dependencies,{action:result.action,skillId:result.id,registrationPath:result.registrationPath,target:result.target.length===0?null:result.target,profileMembershipChanged:false});writeStdout(formatDefaultSkillResult(result));
    return EXIT_STATUS.success;
  }
  if (command.name === 'profile-skill-add' || command.name === 'profile-skill-remove') {
    const options = { bazframeHome };
    const result = command.profileId === undefined
      ? command.name === 'profile-skill-add'
        ? await addActiveProfileSkill(options, command.skillId)
        : await removeActiveProfileSkill(options, command.skillId)
      : command.name === 'profile-skill-add'
        ? await addProfileSkill(options, command.profileId, command.skillId)
        : await removeProfileSkill(options, command.profileId, command.skillId);
    captureResult(dependencies,{action:result.action,profileTarget:{id:result.profileId,source:command.profileId===undefined?'active-selection':'explicit'},skillId:result.skillId,sourceDirectory:result.sourceDirectory,membershipPath:result.membershipPath});
    writeStdout(formatMembershipResult(result, command.profileId !== undefined));
    return EXIT_STATUS.success;
  }
  if (command.name === 'global-overview') {
    const policy = await readGlobalPolicy(bazframeHome);captureResult(dependencies,{policy,statePath:policy==='enabled'?null:globalPolicyPath(bazframeHome)});
    writeStdout(formatGlobalOverview(policy, globalPolicyPath(bazframeHome), stdoutColors));
    return EXIT_STATUS.success;
  }
  if (command.name === 'global-disable') {
    const action = await disableGlobally(bazframeHome);captureResult(dependencies,{action,policy:'disabled',statePath:globalPolicyPath(bazframeHome)});
    writeStdout([
      `Global policy: disabled`,
      `Policy state: ${action}`,
      `State file: ${globalPolicyPath(bazframeHome)}`,
      'Project enabled overrides still take precedence.',
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }
  if (command.name === 'global-enable') {
    await validateRuntimeReady(bazframeHome, environment, dependencies);
    const action = await enableGlobally(bazframeHome);captureResult(dependencies,{action,policy:'enabled',statePath:null});
    writeStdout([
      'Global policy: enabled',
      `Policy state: ${action}`,
      'State file: none (enabled is the default)',
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }

  const cwd = (dependencies.cwd ?? process.cwd)();
  if (command.name === 'projects-overview') {
    const result = await listRepositoryProjectStates(bazframeHome);
    const globalPolicy = await readGlobalPolicy(bazframeHome);
    let currentWorktree: string | undefined;
    let currentProjectState: RepositoryProjectState | undefined;
    try {
      currentWorktree = await findGitRoot(cwd, environment);
      currentProjectState = await readRepositoryProjectState(bazframeHome, currentWorktree);
    } catch (error) {
      if (!(error instanceof BazframeError && error.code === 'NOT_GIT_WORKTREE')) throw error;
    }
    captureResult(dependencies,projectListResult(result.projectStates,currentWorktree,currentProjectState,globalPolicy));
    writeStdout(formatProjectsOverview(result.projectStates,currentWorktree,currentProjectState,globalPolicy,stdoutColors));
    for (const diagnostic of result.diagnostics) reportWarning(dependencies,writeStderr,stderrColors,'PROJECT_STATE_INVALID',diagnostic);
    return EXIT_STATUS.success;
  }
  if (command.name === 'status') {
    const status = await buildStatus({
      bazframeHome,
      bazframeVersion: VERSION,
      environment,
      cwd,
      ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
      ...(dependencies.adapterArtifactUrl === undefined
        ? {}
        : { artifactUrl: dependencies.adapterArtifactUrl })
    });
    writeStdout(colorizeStatus(status.text, stdoutColors));
    return status.exitStatus;
  }
  if (command.name === 'project-disable') {
    const repositoryRoot = await findGitRoot(cwd, environment);
    const result = await disableRepository(bazframeHome, repositoryRoot);captureResult(dependencies,{action:result.action,policy:'disabled',repository:repositoryRoot,globalPolicy:result.globalPolicy,precedence:result.globalPolicy==='disabled'?'inherits-global-disabled':'disabled-project-override'});
    writeStdout([
      'Project policy: disabled',
      `Project state: ${result.action}`,
      `Repository: ${repositoryRoot}`,
      `Global policy: ${result.globalPolicy}`,
      `Precedence: ${result.globalPolicy === 'disabled' ? 'inherits global disabled policy' : 'disabled project override'}`,
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }
  if (command.name === 'project-enable') {
    const repositoryRoot = await findGitRoot(cwd, environment);
    const profileId = await validateRuntimeReady(bazframeHome, environment, dependencies);
    const result = await enableRepository(bazframeHome, repositoryRoot);captureResult(dependencies,{action:result.action,policy:'enabled',repository:repositoryRoot,globalPolicy:result.globalPolicy,precedence:result.globalPolicy==='disabled'?'enabled-project-override':'inherits-global-enabled',profileId});
    writeStdout([
      'Project policy: enabled',
      `Project state: ${result.action}`,
      `Repository: ${repositoryRoot}`,
      `Global policy: ${result.globalPolicy}`,
      `Precedence: ${result.globalPolicy === 'disabled' ? 'enabled project override' : 'inherits global enabled policy'}`,
      `Profile selection: active (${profileId})`,
      'Run `pi` for native context plus the profile.',
      'Run `pi -nc` for global Pi context plus the profile.',
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }

  if (command.name !== 'pi') throw new Error(`Unimplemented command dispatch: ${command.name}`);

  const repositoryRoot = await findGitRoot(cwd, environment);
  const globalPolicy = await readGlobalPolicy(bazframeHome);
  const projectState = await readRepositoryProjectState(bazframeHome, repositoryRoot);
  const effectivePolicy = resolveEffectivePolicy(globalPolicy, projectState);
  if (!effectivePolicy.enabled) {
    throw new Error(
      `Bazframe is disabled for this worktree (${effectivePolicy.reason}). Invoke \`pi\` directly, or run \`bazframe project enable\` first.`
    );
  }
  const profileId = await readActiveProfile(bazframeHome);
  const profile = await loadProfile(bazframeHome, profileId);
  const repositoryInstructions = await loadRootRepositoryInstructions(repositoryRoot);
  const effectiveInstructions = composeInstructions({
    profileId,
    profile: { path: profile.instructionsPath, text: profile.instructions },
    ...(repositoryInstructions === undefined
      ? {}
      : { repository: repositoryInstructions })
  });

  const summary = formatHarnessSummary(
    command.dryRun,
    profile.id,
    repositoryRoot,
    cwd,
    profile.instructionsPath,
    repositoryInstructions?.path,
    profile.skillDirectories
  );

  if (command.dryRun) {
    const conceptualPath = '<temporary .baz.agents.md outside repository>';
    const conceptualArgs = buildPiArgs(
      conceptualPath,
      profile.skillDirectories,
      command.forwardedArgs
    );
    writeStdout([
      summary,
      '--- effective instructions ---',
      effectiveInstructions,
      '--- end effective instructions ---',
      '',
      `Would launch executable: ${dependencies.piExecutable ?? 'pi'}`,
      'Would launch argv:',
      ...conceptualArgs.map((argument) => `  - ${JSON.stringify(argument)}`),
      ''
    ].join('\n'));
    return EXIT_STATUS.success;
  }

  const temporary = await createTemporaryInstructionFile(
    effectiveInstructions,
    repositoryRoot,
    dependencies.temporaryRoot ?? tmpdir()
  );
  try {
    const piArgs = buildPiArgs(
      temporary.path,
      profile.skillDirectories,
      command.forwardedArgs
    );
    writeStderr([
      summary,
      `Effective instructions file: ${temporary.path}`,
      'Launching Pi...',
      ''
    ].join('\n'));
    const child = await spawnPi(
      piArgs,
      cwd,
      environment,
      dependencies.piExecutable ?? 'pi'
    );
    return childExitStatus(child);
  } finally {
    await temporary.cleanup();
  }
}

async function validateRuntimeReady(
  bazframeHome: string,
  environment: NodeJS.ProcessEnv,
  dependencies: CliDependencies
): Promise<string> {
  const adapter = await inspectPiAdapter({
    bazframeHome,
    bazframeVersion: VERSION,
    environment,
    ...(dependencies.userHome === undefined ? {} : { userHome: dependencies.userHome }),
    ...(dependencies.adapterArtifactUrl === undefined
      ? {}
      : { artifactUrl: dependencies.adapterArtifactUrl })
  });
  if (adapter.state !== 'current') {
    throw new BazframeError('PI_ADAPTER_NOT_READY',`Pi adapter state is ${adapter.state}. Run \`bazframe adapter install pi\`, then retry.`);
  }
  const profileId = await readActiveProfile(bazframeHome);
  await loadProfile(bazframeHome, profileId);
  return profileId;
}

function captureResult(dependencies:CliDependencies,result:Record<string,unknown>):void{dependencies.captureResult?.(result);}
function reportWarning(dependencies:CliDependencies,writeStderr:(text:string)=>void,colors:CliColors,code:string,message:string):void{const displayed=boundedTextForDisplay(message);if(dependencies.captureDiagnostic!==undefined)dependencies.captureDiagnostic({level:'warning',code,message:displayed});else writeStderr(`${colors.warning('warning:')} ${displayed}\n`);}
function managedGitResult(result:ManagedGitLifecycleResult):Record<string,unknown>{return{action:result.action,kind:result.kind,id:result.id,remote:result.remote,branch:result.branch,revision:result.revision,root:result.root,sourceType:'remoteGit',resourceAction:result.resourceAction??null,profileMembershipChanged:false};}
function collectionLifecycleResult(result:SkillCollectionLifecycleResult):Record<string,unknown>{const kind=kindForRecord(result);return{action:result.action,kind,id:idForRecord(result),root:result.root,digest:result.digest,skillsRoot:skillsRootForRecord(result),...('package'in result?{artifactRoot:result.artifactRoot}:{}),recordPath:result.path,sourceType:'local',profileMembershipChanged:false};}
function collectionReferenceResult(result:ProfileCollectionReferenceResult,explicit:boolean):Record<string,unknown>{return'library'in result?{action:result.action,kind:'library',id:result.library,referencePath:result.path,profileTarget:{id:result.profileId,source:explicit?'explicit':'active-selection'}}:{action:result.action,kind:'package',id:result.package,referencePath:result.path,profileTarget:{id:result.profileId,source:explicit?'explicit':'active-selection'}};}

function formatGlobalOverview(
  policy: GlobalPolicy,
  path: string,
  colors: CliColors
): string {
  return [
    colors.heading('Global policy'),
    policy === 'enabled'
      ? colors.success('  enabled (default; no state file)')
      : colors.warning('  disabled'),
    `State: ${policy === 'enabled' ? '(none)' : path}`,
    'Project overrides take precedence.',
    '',
    colors.heading('Commands:'),
    colors.command('  bazframe global enable'),
    colors.command('  bazframe global disable'),
    ''
  ].join('\n');
}

function formatProfilesOverview(
  profileIds: readonly string[],
  activeProfile: string | undefined,
  colors: CliColors
): string {
  const activeAvailable = activeProfile !== undefined && profileIds.includes(activeProfile);
  const activeSummary = `Active profile: ${activeProfile === undefined
    ? '(none)'
    : `${activeProfile}${activeAvailable ? '' : ' (unavailable)'}`}`;
  return [
    colors.heading('Profiles'),
    ...(profileIds.length === 0
      ? [colors.muted('  (none)')]
      : profileIds.map((profileId) => profileId === activeProfile
        ? colors.success(`  * ${profileId} (active)`)
        : `  - ${profileId}`)),
    activeAvailable ? colors.success(activeSummary) : colors.warning(activeSummary),
    '',
    colors.heading('Commands:'),
    colors.command('  bazframe profile add <profile>'),
    colors.command('  bazframe profile duplicate <source> <new>'),
    colors.command('  bazframe profile use <profile>'),
    colors.command('  bazframe profile edit <profile>'),
    colors.command('  bazframe profile export <profile> --output <directory>'),
    colors.command('  bazframe profile rename <old> <new>'),
    colors.command('  bazframe profile remove [--force] <profile>'),
    colors.command('  bazframe profile skill list'),
    colors.command('  bazframe profile library list'),
    colors.command('  bazframe profile package list'),
    colors.command('  bazframe profile list'),
    colors.command('  bazframe profile current'),
    ''
  ].join('\n');
}

function formatSkillsOverview(
  skillsRoot: string,
  registrations: readonly { id: string; target: string }[],
  colors: CliColors
): string {
  return [
    colors.heading('Skills'),
    `Added Skills: ${DEFAULT_SKILL_SOURCE_LABEL}`,
    `Catalog: ${skillsRoot}`,
    ...(registrations.length === 0
      ? [colors.muted('  (none)')]
      : registrations.map((registration) => `  - ${registration.id} -> ${registration.target}`)),
    '',
    colors.heading('Commands:'),
    colors.command('  bazframe skill add <absolute-root>'),
    colors.command('  bazframe skill remove <skill>'),
    colors.command('  bazframe skill edit <skill>'),
    colors.command('  bazframe profile skill list'),
    colors.command('  bazframe profile skill add [--profile <profile>] <skill>'),
    colors.command('  bazframe profile skill remove [--profile <profile>] <skill>'),
    ''
  ].join('\n');
}

function formatProfileSkillsOverview(
  profileId: string,
  skillIds: readonly string[],
  colors: CliColors
): string {
  return [
    colors.heading('Profile skills'),
    colors.success(`Active profile: ${profileId}`),
    ...(skillIds.length === 0
      ? [colors.muted('  (none)')]
      : skillIds.map((skillId) => `  - ${skillId}`)),
    '',
    colors.heading('Commands:'),
    colors.command('  bazframe profile skill add [--profile <profile>] <skill>'),
    colors.command('  bazframe profile skill remove [--profile <profile>] <skill>'),
    ''
  ].join('\n');
}

function formatCollectionsOverview(
  kind: SkillCollectionKind,
  inspection: { collections: GlobalSkillCollectionInspection[]; diagnostics: SkillCollectionDiagnostic[] },
  referenceCounts: ReadonlyMap<string, number | 'unknown'>,
  referenceDiagnostics: ReadonlyArray<{ profileId: string; diagnostic: { key: { kind: SkillCollectionKind; id: string }; path: string } }>,
  colors: CliColors
): string {
  const items = inspection.collections.filter((item) => kindForRecord(item.record) === kind);
  const diagnostics = [...inspection.diagnostics.filter((item) => item.collectionKind === kind), ...items.flatMap((item) => item.diagnostics)];
  const plural = kind === 'library' ? 'libraries' : 'packages';
  return [
    colors.heading(`Global ${plural}`),
    ...(items.length === 0 ? [colors.muted('  (none)')] : items.flatMap((item) => {
      const record = item.record; const id = idForRecord(record); const key = collectionKey(kind, id);
      const referenceCount = referenceCounts.get(key) ?? 'unknown'; const health = item.diagnostics.length === 0 && referenceCount !== 'unknown' ? 'ready' : 'failed';
      const roots = kind === 'package' && 'package' in record ? `; artifact root:${record.artifactRoot}; Skills root:${record.skillsRoot}` : '';
      return [`  - ${id} [${health}] -> ${record.root} (sha256:${record.digest}${roots}; ${kind === 'library' ? 'update' : 'build'}:${item.rebuildAvailability}; references:${referenceCount}; Skills:${item.skills.length})`, ...item.skills.map((skill) => `      - ${skill.name} (${skill.relativePath})`)];
    })),
    ...(diagnostics.length === 0 ? [] : [colors.heading(`${kind === 'library' ? 'Library' : 'Package'} failures:`), ...diagnostics.map((diagnostic) => colors.warning(`  - ${formatSkillCollectionDiagnostic(diagnostic)}`))]),
    ...(referenceDiagnostics.length === 0 ? [] : [colors.heading('Reference index failures:'), ...referenceDiagnostics.filter((item) => item.diagnostic.key.kind === kind).map((item) => colors.warning(`  - ${item.profileId}:${item.diagnostic.key.kind}:${item.diagnostic.path} invalid-reference (${item.diagnostic.key.id})`))]),
    '', colors.heading('Commands:'), colors.command(`  bazframe ${kind} add <absolute-root>`), colors.command(`  bazframe ${kind} ${kind === 'library' ? 'update' : 'build'} <${kind}>`), colors.command(`  bazframe ${kind} remove <${kind}>`), ''
  ].join('\n');
}

function formatProfileCollectionsOverview(profileId:string,kind:SkillCollectionKind,composition:ProfileSkillCollectionComposition,colors:CliColors):string{
  const direct=composition.directCollections.filter((item)=>item.collectionKind===kind);const skills=composition.derivedSkills.filter((item)=>item.collectionKind===kind);const diagnostics=composition.diagnostics.filter((item)=>item.collectionKind===kind);const plural=kind==='library'?'libraries':'packages';
  return [colors.heading(`Profile ${plural}`),colors.success(`Active profile: ${profileId}`),colors.heading(`Referenced ${plural}:`),...(direct.length===0?[colors.muted('  (none)')]:direct.map((item)=>item.snapshotDigest===undefined?`  - ${item.collectionId} (target unavailable)`:`  - ${item.collectionId} (sha256:${item.snapshotDigest}; Skills root:${item.skillsRoot})`)),colors.heading('Effective Skills:'),...(skills.length===0?[colors.muted('  (none)')]:skills.map((skill)=>`  - ${skill.name} (${skill.collectionId}:${skill.relativePath})`)),colors.heading(`${kind==='library'?'Library':'Package'} failures:`),...(diagnostics.length===0?[colors.muted('  (none)')]:diagnostics.map((item)=>colors.warning(`  - ${formatSkillCollectionDiagnostic(item)}`))),'',colors.heading('Commands:'),colors.command(`  bazframe profile ${kind} add [--profile <profile>] <${kind}>`),colors.command(`  bazframe profile ${kind} remove [--profile <profile>] <${kind}>`),''].join('\n');
}

function formatProjectsOverview(
  projectStates: readonly RepositoryProjectState[],
  currentWorktree: string | undefined,
  currentProjectState: RepositoryProjectState | undefined,
  globalPolicy: GlobalPolicy,
  colors: CliColors
): string {
  const effective = currentWorktree === undefined
    ? undefined
    : resolveEffectivePolicy(globalPolicy, currentProjectState);
  const currentBehavior = currentWorktree === undefined
    ? '(outside a Git worktree)'
    : `${currentWorktree} (${effective?.enabled === true ? 'enabled' : 'disabled'}; ${effective?.reason})`;
  return [
    colors.heading('Project overrides'),
    `Global policy: ${globalPolicy}`,
    ...(projectStates.length === 0
      ? [colors.muted('  (none)')]
      : projectStates.map((projectState) => {
          const description = projectState.schemaVersion === 3
            ? 'enabled override'
            : projectState.schemaVersion === 2
              ? 'disabled override'
              : 'legacy redundant inherit record';
          const line = `  ${projectState.repository === currentWorktree ? '*' : '-'} ${projectState.repository} (${description})`;
          return projectState.repository === currentWorktree
            ? effective?.enabled === true ? colors.success(line) : colors.warning(line)
            : line;
        })),
    currentWorktree === undefined
      ? colors.muted(`Current worktree: ${currentBehavior}`)
      : effective?.enabled === true
        ? colors.success(`Current worktree: ${currentBehavior}`)
        : colors.warning(`Current worktree: ${currentBehavior}`),
    '',
    colors.heading('Commands:'),
    colors.command('  bazframe project enable'),
    colors.command('  bazframe project disable'),
    ''
  ].join('\n');
}

function formatAdaptersOverview(
  state: string,
  targetPath: string,
  colors: CliColors
): string {
  const adapter = `  - pi (${state})`;
  return [
    colors.heading('Adapters'),
    state === 'current' ? colors.success(adapter) : colors.warning(adapter),
    `Extension: ${targetPath}`,
    '',
    colors.heading('Commands:'),
    colors.command('  bazframe adapter install [--force] pi'),
    colors.command('  bazframe adapter uninstall pi'),
    ''
  ].join('\n');
}

function formatProfileImportPlan(plan: ProfileImportPlan, mode: 'dry-run' | 'execute'): string {
  const list = (heading: string, values: readonly string[]): string[] => [
    heading,
    ...(values.length === 0 ? ['  (none)'] : values.map((value) => `  - ${boundedTextForDisplay(value)}`))
  ];
  const resources = plan.resources.length === 0
    ? ['  (none)']
    : plan.resources.map((resource) => [
        `  - ${resource.kind}:${boundedTextForDisplay(resource.id)} — ${resource.action}`,
        ...(resource.source.type === 'remoteGit' ? [
          `    remote: ${boundedTextForDisplay(resource.source.remote)}`,
          `    fetch URL: ${boundedTextForDisplay(resource.source.fetchUrl)}`,
          `    branch/revision: ${boundedTextForDisplay(resource.source.branch)} @ ${boundedTextForDisplay(resource.source.revision)}`
        ] : [
          `    local mapping: ${resource.source.root === undefined ? '(required)' : boundedPathForDisplay(resource.source.root)}`
        ]),
        `    network required: ${resource.networkRequired ? 'yes' : 'no'}; build required: ${resource.buildRequired ? 'yes' : 'no'}`,
        ...(resource.reason === undefined ? [] : [`    reason: ${boundedTextForDisplay(resource.reason)}`])
      ].join('\n'));
  const blockers = plan.blockers.length === 0
    ? ['  (none)']
    : plan.blockers.map((blocker) => `  - ${boundedTextForDisplay(blocker.code)} [${boundedTextForDisplay(blocker.key)}]: ${boundedTextForDisplay(blocker.message)}`);
  const remoteLibraries = plan.resources
    .filter((resource) => resource.kind === 'library' && resource.source.type === 'remoteGit')
    .map((resource) => resource.id);
  const localLibraries = plan.resources
    .filter((resource) => resource.kind === 'library' && resource.source.type === 'localMapping')
    .map((resource) => resource.id);
  const remotePackages = plan.resources
    .filter((resource) => resource.kind === 'package' && resource.source.type === 'remoteGit')
    .map((resource) => resource.id);
  const localPackages = plan.resources
    .filter((resource) => resource.kind === 'package' && resource.source.type === 'localMapping')
    .map((resource) => resource.id);
  return [
    `Profile import plan (${mode === 'dry-run' ? 'dry-run inspection only' : 'execution inspection'}):`,
    `Artifact: ${boundedPathForDisplay(plan.artifactPath)}`,
    `Schema: ${plan.schemaVersion}`,
    `Exported profile: ${boundedTextForDisplay(plan.exportedProfileId)}`,
    `Destination profile: ${boundedTextForDisplay(plan.destinationProfileId)}`,
    `Instructions: ${boundedTextForDisplay(plan.instructions.path)} (sha256:${boundedTextForDisplay(plan.instructions.sha256)})`,
    ...list('Direct remote Git Skills:', plan.skills),
    ...list('Omitted local Skills:', plan.omittedLocalSkills),
    ...list('Remote Git libraries:', remoteLibraries),
    ...list('Local-mapping libraries:', localLibraries),
    ...list('Remote Git packages:', remotePackages),
    ...list('Local-mapping packages:', localPackages),
    `Package builds: total ${plan.packageBuilds.total}; remote ${plan.packageBuilds.remote}; local ${plan.packageBuilds.local}`,
    ...list('Unresolved remote package builds:', plan.packageBuilds.unresolvedRemotePackageIds),
    ...list('Package build warnings:', plan.packageBuilds.warnings),
    'Resources:',
    ...resources,
    `Active selection: ${plan.activeSelection.state}${plan.activeSelection.profileId === undefined ? '' : ` (${boundedTextForDisplay(plan.activeSelection.profileId)})`}; will change: no`,
    ...(plan.activeSelection.reason === undefined ? [] : [`Active-selection reason: ${boundedTextForDisplay(plan.activeSelection.reason)}`]),
    `Composition: ${plan.composition.status}; known collection Skills: ${plan.composition.knownCollectionSkillCount}`,
    ...list('Deferred libraries:', plan.composition.deferredLibraries),
    ...list('Deferred packages:', plan.composition.deferredPackages),
    ...list('Known collection Skill preview:', plan.composition.knownCollectionSkillPreview),
    `Profile action: ${plan.profileAction}`,
    'Blockers:',
    ...blockers,
    'Exclusions: active selection unchanged; policy unchanged; collection children never enter (default).',
    mode === 'dry-run'
      ? 'Dry-run completed without network acquisition, builds, or Bazframe writes. A blocked plan is still a successful inspection.'
      : 'Execution is authorized only for the displayed create/reuse work and will re-inspect before side effects.',
    ''
  ].join('\n');
}

function formatProfileImportPackageBuildAuthorization(report: PackageBuildAuthorizationReport): string {
  const source = report.source.type === 'remoteGit'
    ? [
        'Source: remote Git',
        `Remote: ${boundedTextForDisplay(report.source.remote)}`,
        `Fetch URL: ${boundedTextForDisplay(report.source.fetchUrl)}`,
        `Branch: ${boundedTextForDisplay(report.source.branch)}`,
        `Revision: ${boundedTextForDisplay(report.source.revision)}`
      ]
    : ['Source: local mapping', `Mapped root: ${boundedPathForDisplay(report.source.root)}`];
  return [
    'Package build authorization report',
    `Package: ${boundedTextForDisplay(report.packageId)}`,
    ...source,
    `Candidate root: ${boundedPathForDisplay(report.candidateRoot)}`,
    `Working directory: ${boundedPathForDisplay(report.cwd)}`,
    `Literal argv: ${stringifyForTerminal(report.argv)}`,
    `Manifest: ${report.manifest.path} (sha256:${boundedTextForDisplay(report.manifest.sha256)})`,
    `Artifact root: ${boundedTextForDisplay(report.artifactRoot)}`,
    `Skills root: ${boundedTextForDisplay(report.skillsRoot)}`,
    'Shell: false',
    'Inherited environment: yes (names and values are not displayed)',
    `Authority: unsandboxed ${report.authority.user}; possible access to ${report.authority.access.join(', ')}`,
    `Warning: ${report.warning}`,
    ''
  ].join('\n');
}

async function confirmProfileImportPackageBuild(): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return await prompt.question('Run this exact package build? [y/N] ') === 'y'; }
  finally { prompt.close(); }
}

function formatPossiblePackageEffects(packageIds: readonly string[]): string[] {
  return [
    'Possible nonrollbackable package-build effects:',
    ...(packageIds.length === 0
      ? ['  (none)']
      : packageIds.map((id) => `  - ${boundedTextForDisplay(id)}`))
  ];
}

function formatProfileImportSuccess(result: ProfileImportResult): string {
  return [
    'Profile import: completed',
    `Profile outcome: ${result.profileOutcome}`,
    `Destination: ${boundedPathForDisplay(result.destinationPath)}`,
    'Resource outcomes:',
    ...(result.resources.length === 0
      ? ['  (none)']
      : result.resources.map((resource) => `  - ${resource.kind}:${boundedTextForDisplay(resource.id)} — ${resource.outcome}`)),
    ...formatPossiblePackageEffects(result.possibleNonrollbackablePackageEffects ?? []),
    'Active selection changed: no',
    'Collection children added to (default): no',
    ''
  ].join('\n');
}

function formatProfileImportPartial(result: ProfileImportPartialResult): string {
  const guidance: string[] = [];
  if (result.resources.some((resource) => resource.outcome === 'recovery-required')) {
    guidance.push('Inspect the reported managed-Git recovery state before retrying.');
  }
  if (result.resources.some((resource) => resource.outcome === 'commit-ambiguous') || result.profileOutcome === 'commit-ambiguous') {
    guidance.push('Rerun profile import inspection; do not assume an ambiguous resource or profile is absent.');
  }
  if (result.profileOutcome === 'published' || result.profileOutcome === 'commit-ambiguous') {
    guidance.push(`Inspect the destination at ${boundedPathForDisplay(result.destinationPath)} before retrying.`);
  }
  if (result.resources.some((resource) => resource.outcome === 'created')) {
    guidance.push('Created global resources are retained and will be re-inspected for exact reuse; Bazframe does not roll them back.');
  }
  if (guidance.length === 0) guidance.push('Fix the reported condition, then rerun import; inspection is recomputed on every retry.');
  return [
    `Profile outcome: ${result.profileOutcome}`,
    `Destination: ${boundedPathForDisplay(result.destinationPath)}`,
    'Resource outcomes:',
    ...(result.resources.length === 0
      ? ['  (none)']
      : result.resources.map((resource) => `  - ${resource.kind}:${boundedTextForDisplay(resource.id)} — ${resource.outcome}`)),
    ...formatPossiblePackageEffects(result.possibleNonrollbackablePackageEffects ?? []),
    'Active selection changed: no',
    ...guidance
  ].join('\n');
}

function formatProfileImportFailure(error: unknown): string {
  if (error instanceof ProfileImportBlockedError) {
    return 'Profile import is blocked by the already reported plan. No acquisition or profile publication was attempted.';
  }
  if (error instanceof ProfileImportPackageBuildAuthorizationRequiredError) {
    return 'The reported profile import plan requires package builds. Noninteractive input must use --yes; no acquisition or profile publication was attempted.';
  }
  if (error instanceof ProfileImportExecutionError) {
    const detail = profileImportFailureDetail(error);
    return `${boundedTextForDisplay(error.message)}${detail === undefined ? '' : `\n${boundedPrefixedTextForDisplay(`Failure detail: ${detail.code} — `, detail.message)}`}\n${formatProfileImportPartial(error.result)}`;
  }
  const detail = boundedTextForDisplay(error instanceof Error ? error.message : String(error));
  return `Profile import did not complete. ${detail}`;
}

function profileImportFailureDiagnostics(error: unknown): ProtocolDiagnostic[] {
  if (!(error instanceof ProfileImportExecutionError)) return [];
  const diagnostics: ProtocolDiagnostic[] = [];
  if (error.result.resources.some((resource) => resource.outcome === 'created')) {
    diagnostics.push({ level: 'warning', code: 'PROFILE_IMPORT_PARTIAL_RESOURCES_RETAINED', message: 'Created global resources remain installed and will be re-inspected for exact reuse on retry.' });
  }
  if (error.result.resources.some((resource) => resource.outcome === 'recovery-required')) {
    diagnostics.push({ level: 'warning', code: 'PROFILE_IMPORT_RECOVERY_REQUIRED', message: 'Inspect managed-Git recovery state before retrying profile import.' });
  }
  if (error.result.resources.some((resource) => resource.outcome === 'commit-ambiguous') || error.result.profileOutcome === 'commit-ambiguous') {
    diagnostics.push({ level: 'warning', code: 'PROFILE_IMPORT_COMMIT_AMBIGUOUS', message: 'Rerun import inspection; do not assume an ambiguous resource or destination is absent.' });
  }
  if (error.result.profileOutcome === 'published' || error.result.profileOutcome === 'commit-ambiguous') {
    diagnostics.push({ level: 'warning', code: 'PROFILE_IMPORT_INSPECT_DESTINATION', message: `Inspect ${boundedPathForDisplay(error.result.destinationPath)} before retrying.` });
  }
  const detail = profileImportFailureDetail(error);
  if (detail !== undefined) {
    diagnostics.push({ level: 'info', code: 'PROFILE_IMPORT_FAILURE_DETAIL', message: boundedPrefixedTextForDisplay(`${detail.code}: `, detail.message) });
  }
  return diagnostics.map(boundGeneratedProfileImportDiagnostic);
}

function boundGeneratedProfileImportDiagnostic(diagnostic: ProtocolDiagnostic): ProtocolDiagnostic {
  const projected = { ...diagnostic, message: boundedTextForDisplay(diagnostic.message) };
  if (Buffer.byteLength(JSON.stringify(projected), 'utf8')
    <= PROFILE_PORTABILITY_PRODUCTION_LIMITS.diagnosticBytes) return projected;
  return {
    ...diagnostic,
    message: 'Profile import diagnostic omitted because it exceeded the generated-diagnostic limit.'
  };
}

function profileImportFailureDetail(error: ProfileImportExecutionError): { code: string; message: string } | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error.cause;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof BazframeError) {
      return { code: current.code, message: current.message };
    }
    if (current instanceof Error) current = current.cause;
    else return undefined;
  }
  return undefined;
}

function profileExportReviewDiagnostic(outputPath: string): string {
  return `Review ${boundedPathForDisplay(join(outputPath, 'profile', 'AGENTS.md'))} before sharing the export.`;
}

function formatProfileExport(result: ProfileExportResult): string {
  const itemLines = (heading: string, values: readonly string[]): string[] => [
    heading,
    ...(values.length === 0
      ? ['  (none)']
      : values.map((value) => `  - ${boundedTextForDisplay(value)}`))
  ];
  const remoteLibraries = result.resources
    .filter((resource) => resource.kind === 'library' && resource.source.type === 'remoteGit')
    .map((resource) => resource.id);
  const localLibraries = result.resources
    .filter((resource) => resource.kind === 'library' && resource.source.type === 'localMapping')
    .map((resource) => resource.id);
  const remotePackages = result.resources
    .filter((resource) => resource.kind === 'package' && resource.source.type === 'remoteGit')
    .map((resource) => resource.id);
  const localPackages = result.resources
    .filter((resource) => resource.kind === 'package' && resource.source.type === 'localMapping')
    .map((resource) => resource.id);
  return [
    `Profile export: ${result.action}`,
    `Profile: ${escapeUnsafeDisplayCharacters(result.exportedProfileId)}`,
    `Output: ${boundedPathForDisplay(result.outputPath)}`,
    `Instructions: ${escapeUnsafeDisplayCharacters(result.instructions.path)} (sha256:${escapeUnsafeDisplayCharacters(result.instructions.sha256)})`,
    ...itemLines('Remote Git Skills:', result.skills),
    ...itemLines('Remote Git libraries:', remoteLibraries),
    ...itemLines('Local-mapping libraries:', localLibraries),
    ...itemLines('Remote Git packages:', remotePackages),
    ...itemLines('Local-mapping packages:', localPackages),
    ...itemLines('Omitted local Skills:', result.omittedLocalSkills),
    ''
  ].join('\n');
}

function formatProfileExportFailure(error: unknown): string {
  if (!(error instanceof ProfileExportError)) {
    const detail = boundedTextForDisplay(error instanceof Error ? error.message : String(error));
    return `The export output was not published. ${detail}`;
  }
  const state = error.commitState === 'published'
    ? 'The export output is published, but completion reporting failed.'
    : error.commitState === 'commit-ambiguous'
      ? 'The export publication state is ambiguous; inspect the requested output before retrying.'
      : 'The export output was not published.';
  return `${state} Output: ${boundedPathForDisplay(error.outputPath)}`;
}

function formatProfileLifecycle(result: ProfileLifecycleResult<string>): string {
  return [
    `Profile lifecycle: ${result.action}`,
    `Profile: ${result.profileId}`,
    `Profile directory: ${result.directory}`,
    ''
  ].join('\n');
}

function formatProfileDuplicate(result: ProfileDuplicateResult): string {
  return [
    `Profile lifecycle: ${result.action}`,
    `Source profile: ${result.sourceProfileId}`,
    `Profile: ${result.profileId}`,
    `Profile directory: ${result.directory}`,
    'Active selection updated: no',
    ''
  ].join('\n');
}

function formatProfileRename(result: ProfileRenameResult): string {
  return [
    `Profile lifecycle: ${result.action}`,
    `Previous profile: ${result.previousProfileId}`,
    `Profile: ${result.profileId}`,
    `Profile directory: ${result.directory}`,
    `Active selection updated: ${result.activeSelectionUpdated ? 'yes' : 'no'}`,
    ''
  ].join('\n');
}

function formatDefaultSkillResult(result: DefaultSkillCatalogResult): string {
  return [
    `Default skill registration: ${result.action}`,
    `Skill: ${result.id}`,
    `Registration: ${result.registrationPath}`,
    `Target: ${result.target.length === 0 ? '(absent)' : result.target}`,
    ''
  ].join('\n');
}

function formatMembershipResult(
  result: ProfileSkillMembershipResult,
  explicitlyTargeted = false
): string {
  return [
    `Profile skill membership: ${result.action}`,
    `Profile: ${result.profileId}`,
    `Profile target: ${explicitlyTargeted ? 'explicit' : 'active-selection'}`,
    `Skill: ${result.skillId}`,
    `Source root: ${result.sourceDirectory}`,
    `Membership: ${result.membershipPath}`,
    ''
  ].join('\n');
}

function formatManagedPackageBuildAuthorization(details: ManagedGitBuildAuthorization): string {
  return [
    'Remote package build authorization',
    `Remote: ${escapeUnsafeDisplayCharacters(details.remote)}`,
    `Revision: ${escapeUnsafeDisplayCharacters(details.revision)}`,
    `Bazframe-managed checkout: ${escapeUnsafeDisplayCharacters(details.root)}`,
    `Build argv: ${stringifyForTerminal(details.build)}`,
    'The declared build runs without a shell or sandbox with current-process-user authority.',
    ''
  ].join('\n');
}

async function confirmManagedPackageBuild(dependencies: CliDependencies): Promise<boolean> {
  if (!(dependencies.stdinIsTty ?? process.stdin.isTTY === true)
    || !(dependencies.stdoutIsTty ?? process.stdout.isTTY === true)) {
    throw new BazframeError('MANAGED_GIT_BUILD_CONFIRMATION_REQUIRED', 'Non-interactive remote package acquisition requires --yes.');
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await prompt.question('Run this package build? [y/N] ')).trim().toLowerCase() === 'y'; }
  finally { prompt.close(); }
}

function formatManagedGitLifecycleResult(result: ManagedGitLifecycleResult): string {
  return [
    `Remote Git source ${result.kind}: ${result.action}`,
    `ID: ${escapeUnsafeDisplayCharacters(result.id)}`,
    `Remote: ${escapeUnsafeDisplayCharacters(result.remote)}`,
    `Branch: ${escapeUnsafeDisplayCharacters(result.branch)}`,
    `Revision: ${escapeUnsafeDisplayCharacters(result.revision)}`,
    `Bazframe-managed checkout: ${escapeUnsafeDisplayCharacters(result.root)}`,
    ...(result.resourceAction === undefined ? [] : [`Resource activation: ${escapeUnsafeDisplayCharacters(result.resourceAction)}`]),
    'Profile membership: unchanged',
    ''
  ].join('\n');
}

function formatCollectionLifecycleResult(result:SkillCollectionLifecycleResult):string{const kind=kindForRecord(result);const id=idForRecord(result);return[`Global ${kind}: ${result.action}`,`${kind==='library'?'Library':'Package'}: ${id}`,`${kind==='library'?'Library':'Package'} root: ${result.root}`,`Snapshot: ${result.digest}`,`Skills root: ${skillsRootForRecord(result)}`,`Record: ${result.path}`,''].join('\n');}
function formatCollectionReferenceResult(result:ProfileCollectionReferenceResult,explicit:boolean):string{if('library'in result)return[`Profile library reference: ${result.action}`,`Profile: ${result.profileId}`,`Profile target: ${explicit?'explicit':'active-selection'}`,`Library: ${result.library}`,`Reference: ${result.path}`,''].join('\n');return[`Profile package reference: ${result.action}`,`Profile: ${result.profileId}`,`Profile target: ${explicit?'explicit':'active-selection'}`,`Package: ${result.package}`,`Reference: ${result.path}`,''].join('\n');}

function formatHarnessSummary(
  dryRun: boolean,
  profileId: string,
  repositoryRoot: string,
  cwd: string,
  profileInstructionsPath: string,
  repositoryInstructionsPath: string | undefined,
  skillDirectories: readonly string[]
): string {
  return [
    `Bazframe legacy launcher${dryRun ? ' dry run' : ''}`,
    `Profile: ${profileId}`,
    `Repository: ${repositoryRoot}`,
    `Working directory: ${cwd}`,
    `Profile instructions: ${profileInstructionsPath}`,
    `Repository instructions: ${repositoryInstructionsPath ?? '(none)'}`,
    'Profile skills:',
    ...(skillDirectories.length === 0
      ? ['  (none)']
      : skillDirectories.map((path) => `  - ${path}`)),
    ''
  ].join('\n');
}

function helpFor(topic: HelpTopic): string {
  switch (topic) {
    case 'root': return ROOT_HELP;
    case 'adapter': return ADAPTER_HELP;
    case 'global': return GLOBAL_HELP;
    case 'status': return STATUS_HELP;
    case 'tui': return TUI_HELP;
    case 'add-skill': return ADD_HELP;
    case 'remove-skill': return REMOVE_HELP;
    case 'profile': return PROFILE_HELP;
    case 'profile-add': return PROFILE_ADD_HELP;
    case 'profile-duplicate': return PROFILE_DUPLICATE_HELP;
    case 'profile-edit': return PROFILE_EDIT_HELP;
    case 'profile-export': return PROFILE_EXPORT_HELP;
    case 'profile-import': return PROFILE_IMPORT_HELP;
    case 'profile-remove': return PROFILE_REMOVE_HELP;
    case 'profile-rename': return PROFILE_RENAME_HELP;
    case 'profile-use': return PROFILE_USE_HELP;
    case 'profile-list': return PROFILE_LIST_HELP;
    case 'profile-current': return PROFILE_CURRENT_HELP;
    case 'profile-skills': return PROFILE_SKILLS_HELP;
    case 'profile-skills-add': return PROFILE_SKILLS_ADD_HELP;
    case 'profile-skills-remove': return PROFILE_SKILLS_REMOVE_HELP;
    case 'profile-libraries': return PROFILE_LIBRARIES_HELP;
    case 'profile-libraries-add': return PROFILE_LIBRARIES_ADD_HELP;
    case 'profile-libraries-remove': return PROFILE_LIBRARIES_REMOVE_HELP;
    case 'profile-packages': return PROFILE_PACKAGES_HELP;
    case 'profile-packages-add': return PROFILE_PACKAGES_ADD_HELP;
    case 'profile-packages-remove': return PROFILE_PACKAGES_REMOVE_HELP;
    case 'libraries': return LIBRARIES_HELP;
    case 'libraries-add': return LIBRARIES_ADD_HELP;
    case 'libraries-update': return LIBRARIES_UPDATE_HELP;
    case 'libraries-remove': return LIBRARIES_REMOVE_HELP;
    case 'packages': return PACKAGES_HELP;
    case 'packages-add': return PACKAGES_ADD_HELP;
    case 'packages-build': return PACKAGES_BUILD_HELP;
    case 'packages-update': return PACKAGES_UPDATE_HELP;
    case 'packages-remove': return PACKAGES_REMOVE_HELP;
    case 'skills': return SKILLS_HELP;
    case 'skill-edit': return SKILL_EDIT_HELP;
    case 'skill-update': return SKILL_UPDATE_HELP;
    case 'project': return PROJECT_HELP;
    case 'pi': return PI_HELP;
  }
}

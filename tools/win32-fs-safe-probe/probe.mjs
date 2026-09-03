import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_PACKAGE = '@openclaw/fs-safe';
const ROOT_VERSION = '0.7.2';
const WIN32_PACKAGE = '@openclaw/fs-safe-win32-x64-msvc';
const WIN32_VERSION = '0.7.2';
// Mirrors the authoritative MAX_BOUNDED_DISPLAY_BYTES in src/core/safe-text.ts.
const DIAGNOSTIC_MAX_BYTES = 768;
const LONG_DIAGNOSTIC = '[value omitted: escaped display exceeds 768 UTF-8 bytes]';
const args = process.argv.slice(2);
const staticOnly = args.includes('--static');
const injectFinalCleanupFailure = args.includes('--test-final-cleanup-failure');
const outputIndex = args.indexOf('--output');
const outputPath = resolve(outputIndex === -1 ? 'evidence.json' : requiredArg(args, outputIndex + 1));

const report = {
  schemaVersion: 2,
  probe: 'bazframe-experimental-win32-fs-safe-foundation',
  purpose: 'Evidence collection only; completion cannot authorize production adoption or a Windows support claim.',
  requestedPackages: { [ROOT_PACKAGE]: ROOT_VERSION, [WIN32_PACKAGE]: WIN32_VERSION },
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    staticOnly,
    testFault: injectFinalCleanupFailure ? 'final-cleanup-failure' : null
  },
  completion: 'failed',
  foundationDecision: {
    disposition: 'pending',
    meaning: 'Not yet evaluated.',
    noGoGates: [],
    pendingGates: [],
    failedGates: []
  },
  productionAdoption: 'not-authorized',
  windowsSupportClaim: false,
  nativeBindingLoad: {
    status: 'not-attested',
    attestedBy: null
  },
  startedAt: new Date().toISOString(),
  completedAt: null,
  publicExports: {},
  gates: foundationGates(),
  failures: []
};

let currentStage = 'initialize';
let attemptedPublicApi = null;
let currentGateId = null;
let probeRoot;

try {
  const rootManifest = await attempt(
    'ordinary-installation',
    'load-root-package-manifest',
    "import.meta.resolve('@openclaw/fs-safe/package.json')",
    () => packageManifest(ROOT_PACKAGE)
  );
  requireObservation(
    rootManifest.version === ROOT_VERSION,
    `Expected ${ROOT_PACKAGE}@${ROOT_VERSION}, received ${String(rootManifest.version)}.`
  );
  requireObservation(
    rootManifest.optionalDependencies?.[WIN32_PACKAGE] === WIN32_VERSION,
    `Expected exact optional dependency ${WIN32_PACKAGE}@${WIN32_VERSION}.`
  );
  requireObservation(
    installScriptNames(rootManifest).length === 0,
    `${ROOT_PACKAGE}@${ROOT_VERSION} unexpectedly declares an install lifecycle script.`
  );

  const main = await attempt(
    'ordinary-installation',
    'load-public-main-api',
    "import('@openclaw/fs-safe')",
    () => import(ROOT_PACKAGE)
  );
  const advanced = await attempt(
    'local-ntfs-admission',
    'load-public-advanced-api',
    "import('@openclaw/fs-safe/advanced')",
    () => import(`${ROOT_PACKAGE}/advanced`)
  );
  const permissions = await attempt(
    'creation-time-privacy',
    'load-public-permissions-api',
    "import('@openclaw/fs-safe/permissions')",
    () => import(`${ROOT_PACKAGE}/permissions`)
  );
  const atomic = await attempt(
    'directory-publication',
    'load-public-atomic-api',
    "import('@openclaw/fs-safe/atomic')",
    () => import(`${ROOT_PACKAGE}/atomic`)
  );
  const locks = await attempt(
    'lock-recovery',
    'load-public-lock-api',
    "import('@openclaw/fs-safe/file-lock')",
    () => import(`${ROOT_PACKAGE}/file-lock`)
  );
  const temp = await attempt(
    'bounded-reclamation',
    'load-public-temp-api',
    "import('@openclaw/fs-safe/temp')",
    () => import(`${ROOT_PACKAGE}/temp`)
  );

  report.publicExports = {
    main: Object.keys(main).sort(),
    advanced: Object.keys(advanced).sort(),
    permissions: Object.keys(permissions).sort(),
    atomic: Object.keys(atomic).sort(),
    fileLock: Object.keys(locks).sort(),
    temp: Object.keys(temp).sort()
  };
  requirePublicFunction(main, 'configureFsSafeNative');
  requirePublicFunction(main, 'getFsSafeNativeConfig');
  evaluatePublicSurfaces({ main, advanced, permissions, atomic, locks, temp }, rootManifest);

  if (staticOnly) {
    if (injectFinalCleanupFailure) {
      probeRoot = join(process.env.RUNNER_TEMP ?? tmpdir(), `bazframe-fs-safe-probe-test-${randomUUID()}`);
      await mkdir(probeRoot);
    }
    report.completion = 'static-only';
  } else {
    currentGateId = 'ordinary-installation';
    currentStage = 'validate-native-target';
    attemptedPublicApi = 'process.platform/process.arch (probe harness)';
    requireObservation(
      process.platform === 'win32' && process.arch === 'x64',
      `Native probe requires win32/x64, received ${process.platform}/${process.arch}.`
    );

    const artifactManifest = await attempt(
      'ordinary-installation',
      'inspect-installed-native-artifact',
      `${WIN32_PACKAGE}/package.json`,
      async () => {
        const manifestPath = fileURLToPath(new URL(
          `./node_modules/${WIN32_PACKAGE}/package.json`,
          import.meta.url
        ));
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        await access(fileURLToPath(new URL(
          `./node_modules/${WIN32_PACKAGE}/fs-safe-native.node`,
          import.meta.url
        )));
        return manifest;
      }
    );
    requireObservation(
      artifactManifest.version === WIN32_VERSION,
      `Expected ${WIN32_PACKAGE}@${WIN32_VERSION}, received ${String(artifactManifest.version)}.`
    );
    requireObservation(
      installScriptNames(artifactManifest).length === 0,
      `${WIN32_PACKAGE}@${WIN32_VERSION} unexpectedly declares an install lifecycle script.`
    );

    await attempt(
      'ordinary-installation',
      'configure-native-required-mode',
      '@openclaw/fs-safe.configureFsSafeNative',
      () => main.configureFsSafeNative({ mode: 'require' })
    );
    const nativeConfig = await attempt(
      'ordinary-installation',
      'read-native-loader-configuration',
      '@openclaw/fs-safe.getFsSafeNativeConfig',
      () => main.getFsSafeNativeConfig()
    );
    requireObservation(nativeConfig.mode === 'require', 'Native loader did not retain require mode.');
    mergeReceipt('ordinary-installation', {
      nativeArtifactVersion: artifactManifest.version,
      rootInstallScripts: installScriptNames(rootManifest),
      nativeArtifactInstallScripts: installScriptNames(artifactManifest),
      loaderMode: nativeConfig.mode,
      loaderModeMeaning: 'Availability policy only; not evidence that an operation used native code.'
    });

    const parent = process.env.RUNNER_TEMP ?? tmpdir();
    probeRoot = join(parent, `bazframe-fs-safe-probe-${randomUUID()}`);
    await attempt(
      'creation-time-privacy',
      'create-private-directory',
      '@openclaw/fs-safe/permissions.createPrivateDirectory',
      () => permissions.createPrivateDirectory(probeRoot)
    );
    report.nativeBindingLoad = {
      status: 'succeeded',
      attestedBy: '@openclaw/fs-safe/permissions.createPrivateDirectory (native-only public API)'
    };
    setMechanism('ordinary-installation', 'native-only-public-api');
    setMechanism('creation-time-privacy', 'native-only-public-api');
    addAttemptedApi(
      'ordinary-installation',
      '@openclaw/fs-safe/permissions.createPrivateDirectory (binding-load attestation)'
    );

    const acl = await attempt(
      'creation-time-privacy',
      'inspect-private-directory-owner-and-dacl',
      '@openclaw/fs-safe/permissions.readOwnerAndDacl',
      () => permissions.readOwnerAndDacl(probeRoot)
    );
    addAttemptedApi('local-ntfs-admission', '@openclaw/fs-safe/permissions.readOwnerAndDacl');
    mergeReceipt('local-ntfs-admission', {
      ownerAndDaclStatus: acl.status,
      isLocal: acl.status === 'supported' ? acl.isLocal : null,
      limitation: 'isLocal does not publicly attest NTFS, mapped-drive locality, stable volume identity, or cloud-placeholder state.'
    });
    requireObservation(acl.status === 'supported', 'Owner/DACL facts were unsupported on native Windows.');
    requireObservation(acl.daclPresent === true, 'Private directory did not report a present DACL.');
    requireObservation(acl.complete === true, 'Private directory DACL facts were incomplete.');
    requireObservation(acl.ownerSid === acl.currentUserSid, 'Private directory owner did not match the current user.');
    requireObservation(acl.isLocal === true, 'Private directory did not report local storage.');
    mergeReceipt('creation-time-privacy', {
      createPrivateDirectoryCompleted: true,
      ownerMatchesCurrentUser: acl.ownerSid === acl.currentUserSid,
      daclPresent: acl.daclPresent,
      daclComplete: acl.complete,
      unsupportedAceTypes: acl.unsupportedAceTypes
    });

    const occupiedPath = join(probeRoot, 'occupied-private-path');
    const occupiedBytes = Buffer.from('preserve occupied entry\n', 'utf8');
    await writeFile(occupiedPath, occupiedBytes);
    let occupiedRefusal;
    try {
      await attempt(
        'creation-time-privacy',
        'refuse-occupied-private-directory-target',
        '@openclaw/fs-safe/permissions.createPrivateDirectory',
        () => permissions.createPrivateDirectory(occupiedPath)
      );
    } catch (error) {
      occupiedRefusal = stagedError(error, {
        stage: currentStage,
        api: attemptedPublicApi,
        expected: true
      });
    }
    requireObservation(occupiedRefusal !== undefined, 'Private-directory creation accepted an occupied file target.');
    const occupiedUnchanged = (await readFile(occupiedPath)).equals(occupiedBytes);
    requireObservation(occupiedUnchanged, 'Occupied private-directory target changed after refusal.');
    setUnchangedState('creation-time-privacy', {
      checked: true,
      result: 'unchanged',
      evidence: {
        scenario: 'occupied regular-file target',
        refusal: occupiedRefusal
      }
    });
    setDisposition(
      'creation-time-privacy',
      'pending-native',
      null,
      'Creation-time DACL and occupied-target refusal were observed, but safe ancestry, inheritance, and every sensitive child class remain unproved.'
    );
    setDisposition(
      'ordinary-installation',
      'pass',
      true,
      'Exact packages were installed and a native-only public API succeeded; this does not attest other operations.'
    );

    report.completion = 'native-probe-completed';
  }
  report.foundationDecision = foundationDecision(report.gates, false);
} catch (error) {
  markCurrentGateFailed(error);
  report.failures.push(stagedError(error));
  report.completion = staticOnly ? 'static-validation-failed' : 'native-probe-failed';
  report.foundationDecision = foundationDecision(report.gates, true);
  process.exitCode = 1;
} finally {
  if (probeRoot !== undefined) {
    currentStage = 'final-probe-root-cleanup';
    attemptedPublicApi = 'node:fs/promises.rm (probe harness cleanup)';
    currentGateId = null;
    try {
      if (injectFinalCleanupFailure) {
        const injected = new Error(`Injected final cleanup failure for ${probeRoot}.`);
        injected.code = 'BAZFRAME_PROBE_TEST_CLEANUP_FAILURE';
        await Promise.reject(injected);
      }
      await rm(probeRoot, { recursive: true, force: true });
    } catch (error) {
      report.failures.push(stagedError(error, {
        stage: currentStage,
        api: attemptedPublicApi,
        expected: false
      }));
      report.completion = 'native-probe-failed';
      report.foundationDecision = foundationDecision(report.gates, true);
      process.exitCode = 1;
    }
  }
  report.completedAt = new Date().toISOString();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' });
  console.log('Bazframe experimental fs-safe evidence report written.');
  console.log([
    `Evidence collection: ${report.completion}`,
    `foundation decision: ${report.foundationDecision.disposition}`,
    `production adoption: ${report.productionAdoption}`,
    `Windows support: ${report.windowsSupportClaim}`
  ].join('; '));
}

function foundationGates() {
  return [
    gate('ordinary-installation', 'Exact ordinary install and lazy native binding load.'),
    gate('local-ntfs-admission', 'Local NTFS, volume identity, mapped/network, and placeholder admission.'),
    gate('exact-identity-and-read', 'Lossless identity and bounded opened-handle pre/post read receipt.'),
    gate('creation-time-privacy', 'Private first visibility and effective owner/DACL evidence.'),
    gate('directory-publication', 'Journal-composable directory publication and recovery receipts.'),
    gate('lock-recovery', 'Cooperating lock with positive dead-owner and PID-reuse evidence.'),
    gate('membership-link-surface', 'Exact directory symlink/junction create, inspect, and link-only remove.'),
    gate('bounded-reclamation', 'Generic bounded identity-proved owned-tree reclamation.')
  ];
}

function gate(id, requiredOutcome) {
  return {
    id,
    requiredForAdoption: true,
    requiredOutcome,
    disposition: 'pending-static',
    attemptedPublicApis: [],
    actualMechanism: 'not-publicly-attested',
    receipt: null,
    unchangedState: { checked: false, result: 'not-checked', evidence: null },
    publicApiComposition: {
      possible: null,
      decision: 'pending',
      reason: 'Public surface not yet evaluated.'
    }
  };
}

function evaluatePublicSurfaces(modules, rootManifest) {
  const has = (module, name) => typeof module[name] === 'function';
  mergeReceipt('ordinary-installation', {
    rootVersion: rootManifest.version,
    declaredWin32Artifact: rootManifest.optionalDependencies?.[WIN32_PACKAGE] ?? null,
    rootInstallScripts: installScriptNames(rootManifest)
  });
  setDisposition(
    'ordinary-installation',
    'pending-native',
    null,
    'Exact package metadata is present; optional artifact presence and lazy native load require native Windows.'
  );
  setUnchangedState('ordinary-installation', {
    checked: false,
    result: 'not-applicable',
    evidence: { reason: 'Installation/load evidence does not mutate a Bazframe-managed namespace.' }
  });

  mergeReceipt('local-ntfs-admission', {
    lexicalNetworkPathCheck: has(modules.advanced, 'assertNoWindowsNetworkPath'),
    ownerAndDaclFacts: has(modules.permissions, 'readOwnerAndDacl'),
    filesystemKindReceipt: false,
    mappedDriveReceipt: false,
    stableVolumeIdentityReceipt: false,
    cloudPlaceholderReceipt: false
  });
  setDisposition(
    'local-ntfs-admission',
    'no-go',
    false,
    'No public API attests filesystem kind, mapped-drive locality, stable volume identity, or cloud-placeholder admission.'
  );
  structuralNoGoUnchangedState('local-ntfs-admission');

  mergeReceipt('exact-identity-and-read', {
    rootReadSurface: has(modules.main, 'root'),
    publicIdentityRepresentation: 'number Stats fields',
    postReadIdentitySizeChangeReceipt: false
  });
  setDisposition(
    'exact-identity-and-read',
    'no-go',
    false,
    'The public read receipt is structurally insufficient: identity is numeric and no post-read identity/size/change receipt is exposed.'
  );
  structuralNoGoUnchangedState('exact-identity-and-read');

  mergeReceipt('creation-time-privacy', {
    createPrivateDirectory: has(modules.permissions, 'createPrivateDirectory'),
    ownerAndDacl: has(modules.permissions, 'readOwnerAndDacl')
  });
  setDisposition(
    'creation-time-privacy',
    has(modules.permissions, 'createPrivateDirectory') && has(modules.permissions, 'readOwnerAndDacl')
      ? 'pending-native'
      : 'no-go',
    has(modules.permissions, 'createPrivateDirectory') && has(modules.permissions, 'readOwnerAndDacl')
      ? null
      : false,
    'Available public privacy surfaces require native first-visibility, effective-DACL, inheritance, and unchanged-state evidence.'
  );

  mergeReceipt('directory-publication', {
    replaceDirectoryAtomic: has(modules.atomic, 'replaceDirectoryAtomic'),
    expectedIdentityReceipt: false,
    journalPredicateReceipt: false,
    ambiguityReceipt: false,
    retainedBackupReceipt: false
  });
  setDisposition(
    'directory-publication',
    'no-go',
    false,
    'The public directory operation exposes no expected identity, journal predicate, ambiguity, or retained-backup receipt.'
  );
  structuralNoGoUnchangedState('directory-publication');

  mergeReceipt('lock-recovery', {
    acquireFileLock: has(modules.locks, 'acquireFileLock'),
    processInstanceOrStartTimeReceipt: false,
    positiveDeadOwnerEvidence: false
  });
  setDisposition(
    'lock-recovery',
    'no-go',
    false,
    'Public locking requires caller-supplied stale-owner authority but exposes no process-instance/PID-reuse evidence.'
  );
  structuralNoGoUnchangedState('lock-recovery');

  const membershipMatches = Object.values(report.publicExports)
    .flat()
    .filter((name) => /junction|symlink|reparse|membership/iu.test(name));
  mergeReceipt('membership-link-surface', { matchingExports: membershipMatches });
  setDisposition(
    'membership-link-surface',
    'no-go',
    false,
    'No public create/inspect/remove directory-symlink-or-junction membership contract exists.'
  );
  structuralNoGoUnchangedState('membership-link-surface');

  mergeReceipt('bounded-reclamation', {
    tempWorkspace: has(modules.temp, 'tempWorkspace'),
    publicIdentityRepresentation: 'numeric dev/ino',
    genericAdoptedOwnedTreeSurface: false
  });
  setDisposition(
    'bounded-reclamation',
    'no-go',
    false,
    'The public cleanup receipt uses numeric identity and is specialized to package-created temp workspaces.'
  );
  structuralNoGoUnchangedState('bounded-reclamation');
}

function structuralNoGoUnchangedState(gateId) {
  setUnchangedState(gateId, {
    checked: false,
    result: 'not-applicable-structural-no-go',
    evidence: { reason: 'No native mutation attempted because public surface evidence is already insufficient.' }
  });
}

async function attempt(gateId, stage, api, operation) {
  currentGateId = gateId;
  currentStage = stage;
  attemptedPublicApi = api;
  addAttemptedApi(gateId, api);
  return await operation();
}

function addAttemptedApi(gateId, api) {
  const target = findGate(gateId);
  if (!target.attemptedPublicApis.includes(api)) target.attemptedPublicApis.push(api);
}

function mergeReceipt(gateId, evidence) {
  const target = findGate(gateId);
  target.receipt = { ...(target.receipt ?? {}), ...evidence };
}

function setMechanism(gateId, mechanism) {
  findGate(gateId).actualMechanism = mechanism;
}

function setUnchangedState(gateId, unchangedState) {
  findGate(gateId).unchangedState = unchangedState;
}

function setDisposition(gateId, disposition, possible, reason) {
  const target = findGate(gateId);
  target.disposition = disposition;
  target.publicApiComposition = {
    possible,
    decision: disposition === 'pass' ? 'pass' : disposition === 'no-go' ? 'no-go' : disposition,
    reason
  };
}

function findGate(id) {
  const target = report.gates.find((candidate) => candidate.id === id);
  if (target === undefined) throw new Error(`Missing probe gate ${id}.`);
  return target;
}

function foundationDecision(gates, executionFailed) {
  const noGoGates = gates.filter(({ disposition }) => disposition === 'no-go').map(({ id }) => id);
  const failedGates = gates.filter(({ disposition }) => disposition === 'failed').map(({ id }) => id);
  const pendingGates = gates
    .filter(({ disposition }) => disposition.startsWith('pending'))
    .map(({ id }) => id);
  if (executionFailed || failedGates.length > 0) {
    return {
      disposition: 'probe-execution-failed',
      meaning: 'Evidence collection failed; this is not a foundation decision or support evidence.',
      noGoGates,
      pendingGates,
      failedGates
    };
  }
  if (noGoGates.length > 0) {
    return {
      disposition: 'no-go',
      meaning: 'Current public APIs cannot compose every required foundation outcome; evidence collection may still have completed successfully.',
      noGoGates,
      pendingGates,
      failedGates
    };
  }
  if (pendingGates.length > 0) {
    return {
      disposition: 'pending-native-evidence',
      meaning: 'No structural no-go was found, but required native evidence is incomplete.',
      noGoGates,
      pendingGates,
      failedGates
    };
  }
  return {
    disposition: 'pass',
    meaning: 'Every foundation gate passed this probe only; production adoption and Windows support remain separately unauthorized.',
    noGoGates,
    pendingGates,
    failedGates
  };
}

function markCurrentGateFailed(error) {
  if (currentGateId === null) return;
  const target = findGate(currentGateId);
  target.disposition = 'failed';
  target.publicApiComposition = {
    possible: null,
    decision: 'failed',
    reason: `Evidence operation failed: ${classifyFailure(error)}`
  };
  target.receipt = {
    ...(target.receipt ?? {}),
    failure: stagedError(error)
  };
}

function requirePublicFunction(module, name) {
  requireObservation(typeof module[name] === 'function', `Required public function ${name} is absent.`);
}

function requireObservation(condition, message) {
  if (!condition) throw new Error(message);
}

async function packageManifest(name) {
  const manifestUrl = import.meta.resolve(`${name}/package.json`);
  return JSON.parse(await readFile(fileURLToPath(manifestUrl), 'utf8'));
}

function installScriptNames(manifest) {
  return manifest.scripts === undefined
    ? []
    : Object.keys(manifest.scripts).filter((name) => /install|postinstall|preinstall/u.test(name));
}

function stagedError(error, overrides = {}) {
  const stage = overrides.stage ?? currentStage;
  const api = overrides.api ?? attemptedPublicApi;
  return {
    stage,
    attemptedPublicApi: api,
    expected: overrides.expected ?? false,
    classification: classifyFailure(error),
    code: boundedDiagnostic(errorCode(error) ?? 'NO_ERROR_CODE'),
    causeChain: boundedCauseChain(error)
  };
}

function classifyFailure(error) {
  const chain = errorCauseObjects(error);
  const codes = chain.map(errorCode).filter(Boolean);
  const messages = chain.map(errorMessage).join(' ');
  if (codes.includes('ERR_DLOPEN_FAILED')) return 'native-dlopen-failed';
  if (
    codes.includes('MODULE_NOT_FOUND')
    || codes.includes('ERR_MODULE_NOT_FOUND')
    || /matching optional native platform package|optional native platform package/iu.test(messages)
  ) return messages.includes(WIN32_PACKAGE) || /native fs-safe helper|native platform package/iu.test(messages)
      ? 'optional-native-artifact-omitted'
      : 'package-or-module-omitted';
  if (/unsupported (?:platform|target)|requires win32\/x64|not supported on/iu.test(messages)) {
    return 'unsupported-target';
  }
  if (codes.includes('helper-unavailable')) return 'native-helper-unavailable';
  return 'public-api-failure';
}

function boundedCauseChain(error) {
  const value = errorCauseObjects(error).map((entry) => {
    const name = entry instanceof Error ? entry.name : 'ErrorLike';
    const code = errorCode(entry);
    return `${name}${code === undefined ? '' : `[${code}]`}: ${errorMessage(entry)}`;
  }).join(' <- caused by: ');
  return boundedDiagnostic(redactPaths(value));
}

function errorCauseObjects(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current !== null && current !== undefined) {
    if (typeof current !== 'object' && typeof current !== 'function') {
      chain.push({ message: String(current) });
      break;
    }
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = 'cause' in current ? current.cause : null;
  }
  if (chain.length === 0) chain.push({ message: String(error) });
  return chain;
}

function errorCode(error) {
  return error !== null
    && (typeof error === 'object' || typeof error === 'function')
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function errorMessage(error) {
  return error !== null
    && (typeof error === 'object' || typeof error === 'function')
    && 'message' in error
    && typeof error.message === 'string'
    ? error.message
    : String(error);
}

function redactPaths(value) {
  return value
    .replace(/file:\/\/\/[A-Za-z]:\/[^\s"'<>]*/giu, 'file:///[path redacted]')
    .replace(/\\\\[^\s"'<>]+/gu, '[path redacted]')
    .replace(/[A-Za-z]:[\\/][^\s"'<>]*/gu, '[path redacted]')
    .replace(/(^|[\s("'=:])\/(?!\/)[^\r\n]*/gmu, '$1[path redacted]');
}

function boundedDiagnostic(value) {
  const escaped = [...String(value)].map((character) => {
    const code = character.codePointAt(0);
    const unsafe = code < 0x20 || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(character);
    if (!unsafe) return character;
    return code <= 0xffff
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : `\\u{${code.toString(16)}}`;
  }).join('');
  return Buffer.byteLength(escaped, 'utf8') <= DIAGNOSTIC_MAX_BYTES
    ? escaped
    : LONG_DIAGNOSTIC;
}

function requiredArg(values, index) {
  const value = values[index];
  if (value === undefined || value.startsWith('--')) throw new Error('--output requires one path.');
  return value;
}

import { spawn } from 'node:child_process';
import { BazframeError } from '../core/errors.js';
import { readOptionalSourceBuildManifest } from './source-build-manifest.js';
import { publishSourceSnapshot, resolvePhysicalRelativeDirectory, type PublishedSnapshot } from './source-snapshot.js';

export interface PreparedSourceUnit {
  snapshot: PublishedSnapshot;
  sourceUnitRoot: string;
  buildExecuted: boolean;
}

export interface SourcePreparationPolicy {
  declaredBuild?: 'execute' | 'reject';
}

export async function prepareSourceUnit(
  bazframeHome: string,
  sourceRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  policy: SourcePreparationPolicy = {}
): Promise<PreparedSourceUnit> {
  const manifest = await readOptionalSourceBuildManifest(sourceRoot);
  if (manifest !== undefined && policy.declaredBuild === 'reject') {
    throw new BazframeError(
      'SOURCE_BUILD_REQUIRES_CLI',
      'This source declares a build. Use `bazframe sources add <absolute-root>` in a terminal so the unsandboxed build and its output remain visible.'
    );
  }
  if (manifest !== undefined) await executeBuild(manifest.build, sourceRoot, environment);
  const artifactRelative = manifest?.artifactRoot ?? '.';
  const sourceUnitRoot = manifest?.sourceUnitRoot ?? '.';
  const artifactRoot = await resolvePhysicalRelativeDirectory(sourceRoot, artifactRelative);
  await resolvePhysicalRelativeDirectory(artifactRoot, sourceUnitRoot);
  const snapshot = await publishSourceSnapshot(bazframeHome, artifactRoot);
  await resolvePhysicalRelativeDirectory(snapshot.artifactRoot, sourceUnitRoot);
  return { snapshot, sourceUnitRoot, buildExecuted: manifest !== undefined };
}

async function executeBuild(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, env, shell: false, stdio: 'inherit' });
    } catch (error) {
      reject(new BazframeError('SOURCE_BUILD_FAILED', `Could not start source build: ${argv[0]}`, { cause: error }));
      return;
    }
    child.once('error', (error) => reject(new BazframeError('SOURCE_BUILD_FAILED', `Could not start source build: ${argv[0]}`, { cause: error })));
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new BazframeError('SOURCE_BUILD_FAILED', signal === null
        ? `Source build exited with status ${code ?? 1}.`
        : `Source build terminated by signal ${signal}.`));
    });
  });
}

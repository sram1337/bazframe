import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ChildResult } from '../core/child-process.js';
import {
  launchExternalEditor,
  type InheritedChildRunner
} from '../core/external-editor.js';
import { BazframeError, errorCode } from '../core/errors.js';
import {
  readDefaultSkillRegistrationSnapshot,
  sameDefaultSkillRegistrationSnapshot
} from './default-skill-catalog.js';
import { assertSafeSkillId } from './skill-id.js';
import { optionalManagedGitRecord } from '../providers/managed-git-record.js';

export interface SkillDefinitionEditorOptions {
  bazframeHome: string;
  skillId: string;
  environment: NodeJS.ProcessEnv;
  childRunner?: InheritedChildRunner;
  testHooks?: {
    beforeRevalidate?: () => void | Promise<void>;
  };
}

export interface SkillDefinitionEditorTarget {
  skillId: string;
  providerRoot: string;
  definitionPath: string;
}

interface DefinitionIdentity {
  path: string;
  device: bigint;
  inode: bigint;
}

export async function editSkillDefinition(
  options: SkillDefinitionEditorOptions
): Promise<ChildResult> {
  const target = await resolveSkillDefinitionEditorTarget(options);
  return launchExternalEditor({
    target: { path: target.definitionPath, cwd: target.providerRoot },
    environment: options.environment,
    ...(options.childRunner === undefined ? {} : { childRunner: options.childRunner })
  });
}

export async function resolveSkillDefinitionEditorTarget(
  options: Pick<SkillDefinitionEditorOptions, 'bazframeHome' | 'skillId' | 'testHooks'>
): Promise<SkillDefinitionEditorTarget> {
  assertSafeSkillId(options.skillId);
  if (await optionalManagedGitRecord(options.bazframeHome, 'skill', options.skillId) !== undefined) {
    throw new BazframeError(
      'MANAGED_GIT_SKILL_EDIT_REFUSED',
      `Skill ${JSON.stringify(options.skillId)} was acquired from a remote Git source. Edit its upstream repository, then run \`bazframe skill update ${options.skillId}\`.`
    );
  }
  const before = await readDefaultSkillRegistrationSnapshot(
    options.bazframeHome,
    options.skillId,
    { validateDeclaredName: false }
  );
  const definitionBefore = await resolveDefinition(before.target, options.skillId);

  await options.testHooks?.beforeRevalidate?.();

  const after = await readDefaultSkillRegistrationSnapshot(
    options.bazframeHome,
    options.skillId,
    { validateDeclaredName: false }
  );
  if (!sameDefaultSkillRegistrationSnapshot(before, after)) {
    throw new BazframeError(
      'SKILL_EDITOR_TARGET_CHANGED',
      `Refusing to open changed default skill registration: ${before.registrationPath}`
    );
  }
  const definitionAfter = await resolveDefinition(after.target, options.skillId);
  if (
    definitionAfter.path !== definitionBefore.path
    || definitionAfter.device !== definitionBefore.device
    || definitionAfter.inode !== definitionBefore.inode
  ) {
    throw new BazframeError(
      'SKILL_EDITOR_TARGET_CHANGED',
      `Refusing to open changed skill definition: ${join(after.target, 'SKILL.md')}`
    );
  }

  return {
    skillId: options.skillId,
    providerRoot: after.target,
    definitionPath: definitionAfter.path
  };
}

async function resolveDefinition(providerRoot: string, skillId: string): Promise<DefinitionIdentity> {
  const enteredPath = join(providerRoot, 'SKILL.md');
  let canonical: string;
  try {
    canonical = await realpath(enteredPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new BazframeError(
        'SKILL_DEFINITION_NOT_FOUND',
        `Default skill ${JSON.stringify(skillId)} definition does not exist: ${enteredPath}`
      );
    }
    throw new BazframeError(
      'SKILL_DEFINITION_READ_FAILED',
      `Could not resolve default skill ${JSON.stringify(skillId)} definition: ${enteredPath}`,
      { cause: error }
    );
  }
  if (!isWithin(providerRoot, canonical)) {
    throw new BazframeError(
      'SKILL_DEFINITION_ESCAPES_ROOT',
      `Default skill ${JSON.stringify(skillId)} definition must remain within its source root: ${enteredPath} -> ${canonical}`
    );
  }
  let metadata;
  try {
    metadata = await stat(canonical, { bigint: true });
  } catch (error) {
    throw new BazframeError(
      'SKILL_DEFINITION_READ_FAILED',
      `Could not inspect default skill ${JSON.stringify(skillId)} definition: ${canonical}`,
      { cause: error }
    );
  }
  if (!metadata.isFile()) {
    throw new BazframeError(
      'SKILL_DEFINITION_NOT_FILE',
      `Default skill ${JSON.stringify(skillId)} definition must resolve to a regular file: ${enteredPath}`
    );
  }
  return { path: canonical, device: metadata.dev, inode: metadata.ino };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

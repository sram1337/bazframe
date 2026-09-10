import { homedir } from 'node:os';
import type { ApplicationServices } from '../../application/application-services.js';
import { BazframeError } from '../../core/errors.js';
import { readActiveProfile, loadProfile } from '../../profiles/profile-store.js';
import { findGitRoot } from '../../project/git-root.js';
import { readGlobalPolicy } from '../../policy/global-policy.js';
import { readRepositoryProjectState } from '../../project/registration-store.js';
import { resolveBazframeHome, resolvePiAgentDirectory } from '../../state/paths.js';
import { projectManagedProfileRuntime } from '../../profile-publishing/profile-runtime-projection.js';
import { loadFlatSkillIdentitiesWithEffects, resolveProfileSkillCollections, type RuntimeSkillMetadata } from '../../skill-collections/skill-collection-resolver.js';

export interface PiRuntimeServices {
  paths: ApplicationServices['paths'];
  home(): string;
  findRepository(cwd: string): Promise<string | undefined>;
  readGlobalPolicy: typeof readGlobalPolicy;
  readProjectState: typeof readRepositoryProjectState;
  loadProfile(home: string): Promise<PiRuntimeProfile>;
  loadGlobalContext(): Promise<{ path: string; content: string } | undefined>;
  writeAlias(path: string, contents: string, home: string): Promise<void>;
}
export interface PiRuntimeProfile {
  id: string; directory: string; instructionsPath: string; instructions: string;
  flatSkills: RuntimeSkillMetadata[];
  directCollections: Awaited<ReturnType<typeof resolveProfileSkillCollections>>['directCollections'];
  derivedSkills: Array<Awaited<ReturnType<typeof resolveProfileSkillCollections>>['derivedSkills'][number] & { skill: RuntimeSkillMetadata }>;
  collectionDiagnostics: Awaited<ReturnType<typeof resolveProfileSkillCollections>>['diagnostics'];
  skills: RuntimeSkillMetadata[]; skillDirectories: string[]; warnings: string[];
}
export function createPiRuntimeServices(application: ApplicationServices, environment: NodeJS.ProcessEnv, effects: {
  readContext(path: string): Promise<string | undefined>;
  writeAlias: PiRuntimeServices['writeAlias'];
}, userHome = homedir()): PiRuntimeServices {
  const paths = application.paths;
  return {
    paths, home: () => resolveBazframeHome(environment, userHome, paths),
    async findRepository(cwd) {
      try { return await findGitRoot(cwd, environment, application.gitRoot); }
      catch (error) { if (error instanceof BazframeError && error.code === 'NOT_GIT_WORKTREE') return undefined; throw error; }
    },
    readGlobalPolicy: (home) => readGlobalPolicy(home, application.policy),
    readProjectState: (home, repository) => readRepositoryProjectState(home, repository, application.policy),
    async loadProfile(home) {
      const id = await readActiveProfile(home, application.selection), profile = await loadProfile(home, id, application.profiles);
      const resolver = application.projection!.resolver;
      const imported = await projectManagedProfileRuntime(home, id, application.projection);
      const flat = await loadFlatSkillIdentitiesWithEffects(profile.skillDirectories, resolver);
      const collections = await resolveProfileSkillCollections(profile.directory, [...flat, ...imported.skills], resolver.definitionLoader, resolver);
      const metadata = (value: unknown): RuntimeSkillMetadata => {
        const skill = value as RuntimeSkillMetadata | undefined;
        if (skill === undefined || typeof skill.description !== 'string' || typeof skill.baseDir !== 'string' || typeof skill.filePath !== 'string') throw new BazframeError('PROFILE_RUNTIME_PROJECTION_INVALID', 'Host Pi declared Skill metadata is unavailable.');
        return skill;
      };
      const flatSkills = flat.map((skill) => metadata(skill.loaded));
      const derivedSkills = collections.derivedSkills.map((skill) => ({ ...skill, skill: metadata(skill.loaded) }));
      const skills = [...flatSkills, ...derivedSkills.map((skill) => skill.skill), ...imported.skills.map((skill) => metadata(skill.loaded))];
      if (new Set(skills.map((skill) => skill.name)).size !== skills.length) throw new BazframeError('PROFILE_RUNTIME_PROJECTION_INVALID', 'Duplicate profile Skill names.');
      return { id, directory: profile.directory, instructionsPath: profile.instructionsPath, instructions: profile.instructions, flatSkills, directCollections: collections.directCollections, derivedSkills, collectionDiagnostics: collections.diagnostics, skills, skillDirectories: [...new Set(skills.map((skill) => skill.baseDir))].sort(), warnings: [] };
    },
    async loadGlobalContext() {
      for (const name of ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']) {
        const path = paths.join(resolvePiAgentDirectory(environment, userHome, paths), name);
        const content = await effects.readContext(path);
        if (content !== undefined) return { path, content };
      }
      return undefined;
    },
    writeAlias: effects.writeAlias
  };
}

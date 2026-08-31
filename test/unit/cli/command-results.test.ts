import { describe, expect, it } from 'vitest';
import {
  profileExportResult,
  profileImportDryRunResult,
  profileImportExecutionResult,
  profileImportPartialResult,
  profileImportPlanResult
} from '../../../src/cli/command-results.js';
import type { ProfileExportResult } from '../../../src/profile-portability/profile-export.js';
import type { ProfileImportPlan } from '../../../src/profile-portability/profile-import-plan.js';

const importPlan: ProfileImportPlan = {
  artifactPath: '/artifact', schemaVersion: 1, exportedProfileId: 'portable', destinationProfileId: 'review',
  instructions: { path: 'profile/AGENTS.md', sha256: 'c'.repeat(64) },
  skills: ['review-tools'], omittedLocalSkills: ['local-only'], libraries: ['toolkit'], packages: [],
  resources: [{
    kind: 'skill', id: 'review-tools', source: { type: 'remoteGit', remote: 'git:owner/review-tools', fetchUrl: 'https://example.test/owner/review-tools.git', branch: 'main', revision: 'd'.repeat(40) },
    action: 'create', networkRequired: true, buildRequired: false
  }],
  activeSelection: { state: 'selected', profileId: 'focused', willChange: false },
  composition: { status: 'deferred', deferredLibraries: ['toolkit'], knownCollectionSkillCount: 0, knownCollectionSkillPreview: [] },
  exclusions: { activeSelectionWillChange: false, policyWillChange: false, collectionChildrenEnterDefault: false },
  profileAction: 'publish', blockers: []
};

describe('profile import command results', () => {
  it('projects complete plans and outcomes without internal health evidence', () => {
    const plan = profileImportPlanResult(importPlan);
    expect(plan).toEqual({
      artifactPath:'/artifact',schemaVersion:1,exportedProfileId:'portable',destinationProfileId:'review',
      instructions:{path:'profile/AGENTS.md',digest:'c'.repeat(64)},skills:['review-tools'],omittedLocalSkills:['local-only'],libraries:['toolkit'],packages:[],
      resources:[{kind:'skill',id:'review-tools',sourceType:'remoteGit',remote:'git:owner/review-tools',fetchUrl:'https://example.test/owner/review-tools.git',branch:'main',revision:'d'.repeat(40),action:'create',networkRequired:true,buildRequired:false}],
      activeSelection:{state:'selected',profileId:'focused',willChange:false},
      composition:{status:'deferred',deferredLibraries:['toolkit'],knownCollectionSkillCount:0,knownCollectionSkillPreview:[]},
      exclusions:{activeSelectionWillChange:false,policyWillChange:false,collectionChildrenEnterDefault:false},profileAction:'publish',blockers:[]
    });
    expect(profileImportDryRunResult(importPlan)).toEqual({mode:'dry-run',plan});
    expect(profileImportExecutionResult({plan:importPlan,resources:[{kind:'skill',id:'review-tools',outcome:'created'}],profileOutcome:'published',destinationPath:'/home/profiles/review',activeSelectionChanged:false}))
      .toEqual({mode:'executed',plan,resources:[{kind:'skill',id:'review-tools',outcome:'created'}],profileOutcome:'published',destinationPath:'/home/profiles/review',activeSelectionChanged:false});
    expect(profileImportPartialResult({plan:importPlan,resources:[{kind:'skill',id:'review-tools',outcome:'commit-ambiguous'}],profileOutcome:'commit-ambiguous',destinationPath:'/home/profiles/review',activeSelectionChanged:false}))
      .toEqual({mode:'partial',plan,resources:[{kind:'skill',id:'review-tools',outcome:'commit-ambiguous'}],profileOutcome:'commit-ambiguous',destinationPath:'/home/profiles/review',activeSelectionChanged:false});
    for (const forbidden of ['health','snapshot','device','inode','evidence','homePath','artifactSnapshot','resourceSnapshots']) expect(JSON.stringify(plan)).not.toContain(forbidden);
  });
});

describe('profileExportResult', () => {
  it('projects a remote Git resource through the exact public DTO', () => {
    const result: ProfileExportResult = {
      action: 'published',
      exportedProfileId: 'portable',
      outputPath: '/public/export',
      instructions: { path: 'profile/AGENTS.md', sha256: 'a'.repeat(64) },
      skills: ['review-tools'],
      omittedLocalSkills: [],
      libraries: [],
      packages: [],
      resources: [{
        kind: 'skill',
        id: 'review-tools',
        source: {
          type: 'remoteGit',
          remote: 'git:owner/review-tools',
          fetchUrl: 'https://example.test/owner/review-tools.git',
          branch: 'main',
          revision: 'b'.repeat(40)
        }
      }],
      warnings: []
    };

    const projected = profileExportResult(result);

    expect(projected.resources).toEqual([{
      kind: 'skill',
      id: 'review-tools',
      sourceType: 'remoteGit',
      remote: 'git:owner/review-tools',
      fetchUrl: 'https://example.test/owner/review-tools.git',
      branch: 'main',
      revision: 'b'.repeat(40)
    }]);
    for (const field of ['checkout', 'evidence', 'internal', 'root', 'transport']) {
      expect(JSON.stringify(projected.resources)).not.toContain(field);
    }
  });
});

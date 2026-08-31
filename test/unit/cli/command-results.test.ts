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

  it('projects only the canonical root for resolved local mappings and omits it when missing', () => {
    const localPlan: ProfileImportPlan = {
      ...importPlan,
      resources: [
        {kind:'library',id:'mapped',source:{type:'localMapping',root:'/canonical/mapped'},action:'create',networkRequired:false,buildRequired:false},
        {kind:'library',id:'missing',source:{type:'localMapping'},action:'blocked',networkRequired:false,buildRequired:false,reason:'mapping required'}
      ]
    };
    const projected = profileImportPlanResult(localPlan);
    expect(projected.resources).toEqual([
      {kind:'library',id:'mapped',sourceType:'localMapping',root:'/canonical/mapped',action:'create',networkRequired:false,buildRequired:false},
      {kind:'library',id:'missing',sourceType:'localMapping',action:'blocked',networkRequired:false,buildRequired:false,reason:'mapping required'}
    ]);
    const serialized = JSON.stringify(projected.resources);
    for (const forbidden of ['device','inode','digest','snapshot','evidence']) expect(serialized).not.toContain(forbidden);
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

  it('projects local libraries path-free without source-machine or snapshot evidence', () => {
    const result: ProfileExportResult = {
      action:'published',exportedProfileId:'portable',outputPath:'/public/export',
      instructions:{path:'profile/AGENTS.md',sha256:'a'.repeat(64)},skills:[],omittedLocalSkills:[],libraries:['toolkit'],packages:[],
      resources:[{kind:'library',id:'toolkit',source:{type:'localMapping'}}],warnings:[]
    };
    expect(profileExportResult(result).resources).toEqual([{kind:'library',id:'toolkit',sourceType:'localMapping'}]);
    const serialized = JSON.stringify(profileExportResult(result).resources);
    for (const field of ['root','digest','device','inode','snapshot','evidence']) expect(serialized).not.toContain(field);
  });
});

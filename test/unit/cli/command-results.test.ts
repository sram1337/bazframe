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
  packageBuilds: { total: 0, remote: 0, local: 0, unresolvedRemotePackageIds: [], warnings: [] },
  activeSelection: { state: 'selected', profileId: 'focused', willChange: false },
  composition: { status: 'deferred', deferredLibraries: ['toolkit'], deferredPackages: [], knownCollectionSkillCount: 0, knownCollectionSkillPreview: [] },
  exclusions: { activeSelectionWillChange: false, policyWillChange: false, collectionChildrenEnterDefault: false },
  profileAction: 'publish', blockers: []
};

describe('profile import command results', () => {
  it('projects safe package planning counts and warnings without build evidence', () => {
    const packagePlan: ProfileImportPlan = {
      ...importPlan,
      skills: [],
      libraries: [],
      packages: ['automation', 'local-tools'],
      resources: [
        {
          kind: 'package', id: 'automation',
          source: {
            type: 'remoteGit', remote: 'git:owner/automation', fetchUrl: 'https://example.test/owner/automation.git',
            branch: 'main', revision: 'e'.repeat(40)
          },
          action: 'create', networkRequired: true, buildRequired: true
        },
        {
          kind: 'package', id: 'local-tools', source: { type: 'localMapping', root: '/intentional/local-tools' },
          action: 'create', networkRequired: false, buildRequired: true
        }
      ],
      packageBuilds: {
        total: 2,
        remote: 1,
        local: 1,
        unresolvedRemotePackageIds: ['automation'],
        warnings: ['Package builds execute with shell:false and inherit the parent environment.']
      },
      composition: { ...importPlan.composition, deferredLibraries: [], deferredPackages: ['automation', 'local-tools'] }
    };
    const projected = profileImportPlanResult(packagePlan);
    expect(projected).toMatchObject({
      packages: ['automation', 'local-tools'],
      packageBuilds: { total: 2, remote: 1, local: 1, unresolvedRemotePackageIds: ['automation'] },
      resources: [
        expect.objectContaining({ kind: 'package', sourceType: 'remoteGit', buildRequired: true }),
        expect.objectContaining({ kind: 'package', sourceType: 'localMapping', root: '/intentional/local-tools', buildRequired: true })
      ]
    });
    expect(JSON.stringify(projected)).not.toMatch(/manifest|argv|device|inode|checkout|staging|physical/u);
  });

  it('projects complete plans and outcomes without internal health evidence', () => {
    const plan = profileImportPlanResult(importPlan);
    expect(plan).toEqual({
      artifactPath:'/artifact',schemaVersion:1,exportedProfileId:'portable',destinationProfileId:'review',
      instructions:{path:'profile/AGENTS.md',digest:'c'.repeat(64)},skills:['review-tools'],omittedLocalSkills:['local-only'],libraries:['toolkit'],packages:[],
      resources:[{kind:'skill',id:'review-tools',sourceType:'remoteGit',remote:'git:owner/review-tools',fetchUrl:'https://example.test/owner/review-tools.git',branch:'main',revision:'d'.repeat(40),action:'create',networkRequired:true,buildRequired:false}],
      packageBuilds:{total:0,remote:0,local:0,unresolvedRemotePackageIds:[],warnings:[]},
      activeSelection:{state:'selected',profileId:'focused',willChange:false},
      composition:{status:'deferred',deferredLibraries:['toolkit'],deferredPackages:[],knownCollectionSkillCount:0,knownCollectionSkillPreview:[]},
      exclusions:{activeSelectionWillChange:false,policyWillChange:false,collectionChildrenEnterDefault:false},profileAction:'publish',blockers:[]
    });
    expect(profileImportDryRunResult(importPlan)).toEqual({mode:'dry-run',plan});
    expect(profileImportExecutionResult({plan:importPlan,resources:[{kind:'skill',id:'review-tools',outcome:'created'}],profileOutcome:'published',destinationPath:'/home/profiles/review',activeSelectionChanged:false}))
      .toEqual({mode:'executed',plan,resources:[{kind:'skill',id:'review-tools',outcome:'created'}],profileOutcome:'published',destinationPath:'/home/profiles/review',activeSelectionChanged:false,packageBuildReports:[],possibleNonrollbackablePackageEffects:[]});
    expect(profileImportPartialResult({plan:importPlan,resources:[{kind:'skill',id:'review-tools',outcome:'commit-ambiguous'}],profileOutcome:'commit-ambiguous',destinationPath:'/home/profiles/review',activeSelectionChanged:false}))
      .toEqual({mode:'partial',plan,resources:[{kind:'skill',id:'review-tools',outcome:'commit-ambiguous'}],profileOutcome:'commit-ambiguous',destinationPath:'/home/profiles/review',activeSelectionChanged:false,packageBuildReports:[],possibleNonrollbackablePackageEffects:[]});
    for (const forbidden of ['health','snapshot','device','inode','evidence','homePath','artifactSnapshot','resourceSnapshots']) expect(JSON.stringify(plan)).not.toContain(forbidden);
  });

  it('projects package reports through an explicit JSON-safe allow-list', () => {
    const report = {
      packageId:'automation',
      source:{type:'remoteGit' as const,remote:'example.test/team/automation',fetchUrl:'https://example.test/team/automation.git',branch:'main',revision:'e'.repeat(40)},
      candidateRoot:'/private/home/providers/git/checkouts/package/automation',
      cwd:'/private/home/providers/git/checkouts/package/automation',
      argv:['node','build.mjs','--literal=value'],
      manifest:{path:'bazframe-package.json' as const,sha256:'a'.repeat(64)},
      artifactRoot:'dist',skillsRoot:'skills',shell:false as const,
      environment:{inherited:true as const,namesAndValuesExposed:false as const},
      authority:{sandboxed:false as const,user:'current-process-user' as const,access:['credentials','network','user-files'] as const},
      warning:'Package build side effects are not rollbackable.' as const
    };
    const projected=profileImportExecutionResult({
      plan:importPlan,resources:[{kind:'package',id:'automation',outcome:'created'}],profileOutcome:'published',
      destinationPath:'/home/profiles/review',activeSelectionChanged:false,packageBuildReports:[report],
      possibleNonrollbackablePackageEffects:['automation']
    });
    expect(projected).toMatchObject({
      packageBuildReports:[{
        packageId:'automation',
        source:{type:'remoteGit',remote:'example.test/team/automation',fetchUrl:'https://example.test/team/automation.git',branch:'main',revision:'e'.repeat(40)},
        argv:['node','build.mjs','--literal=value'],manifest:{path:'bazframe-package.json',sha256:'a'.repeat(64)},
        artifactRoot:'dist',skillsRoot:'skills',shell:false,inheritedEnvironment:true,
        authority:{sandboxed:false,user:'current-process-user',access:['credentials','network','user-files']},
        warning:'Package build side effects are not rollbackable.'
      }],
      possibleNonrollbackablePackageEffects:['automation']
    });
    const serialized=JSON.stringify(projected);
    expect(serialized).not.toContain(report.candidateRoot);
    for(const forbidden of ['candidateRoot','cwd','device','inode','snapshot','environment":','cause','stack']) expect(serialized).not.toContain(forbidden);
  });

  it('allows the intentional mapped root in a local package report', () => {
    const projected=profileImportPartialResult({
      plan:importPlan,resources:[{kind:'package',id:'local-tools',outcome:'not-created'}],profileOutcome:'not-published',
      destinationPath:'/home/profiles/review',activeSelectionChanged:false,
      packageBuildReports:[{
        packageId:'local-tools',source:{type:'localMapping',root:'/intentional/local-tools'},candidateRoot:'/intentional/local-tools',cwd:'/intentional/local-tools',
        argv:['node','build.mjs'],manifest:{path:'bazframe-package.json',sha256:'b'.repeat(64)},artifactRoot:'dist',skillsRoot:'skills',shell:false,
        environment:{inherited:true,namesAndValuesExposed:false},authority:{sandboxed:false,user:'current-process-user',access:['credentials','network','user-files']},
        warning:'Package build side effects are not rollbackable.'
      }],possibleNonrollbackablePackageEffects:[]
    });
    expect(projected).toMatchObject({packageBuildReports:[{
      source:{type:'localMapping',root:'/intentional/local-tools'},
      candidateRoot:'/intentional/local-tools',cwd:'/intentional/local-tools'
    }]});
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

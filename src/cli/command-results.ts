import type { ProfileExportResult } from '../profile-portability/profile-export.js';
import type { ProfileImportPlan } from '../profile-portability/profile-import-plan.js';
import type { ProfileImportPartialResult, ProfileImportResult } from '../profile-portability/profile-import.js';
import type { PackageBuildAuthorizationReport } from '../profile-portability/profile-import-package-build.js';
import type { RepositoryProjectState } from '../project/registration.js';
import type { GlobalPolicy } from '../policy/global-policy.js';
import type { StatusInspection } from '../status/status.js';
import type {
  GlobalSkillCollectionInspection,
  ProfileSkillCollectionComposition,
  SkillCollectionDiagnostic
} from '../skill-collections/skill-collection-resolver.js';
import { collectionKey, idForRecord, kindForRecord, skillsRootForRecord, type SkillCollectionKind } from '../skill-collections/skill-collection-store.js';
import type { SharedProfileApplicationProjection } from '../profile-publishing/profile-application-projection.js';

export interface ProtocolDiagnostic { level:'warning'|'info'; code:string; message:string }

export function profileImportPlanResult(plan: ProfileImportPlan): Record<string, unknown> {
 return {
  artifactPath:plan.artifactPath,
  schemaVersion:plan.schemaVersion,
  exportedProfileId:plan.exportedProfileId,
  destinationProfileId:plan.destinationProfileId,
  instructions:{path:plan.instructions.path,digest:plan.instructions.sha256},
  skills:[...plan.skills],
  omittedLocalSkills:[...plan.omittedLocalSkills],
  libraries:[...plan.libraries],
  packages:[...plan.packages],
  resources:plan.resources.map((resource)=>resource.source.type==='remoteGit'?{
   kind:resource.kind,id:resource.id,sourceType:'remoteGit',remote:resource.source.remote,
   fetchUrl:resource.source.fetchUrl,branch:resource.source.branch,revision:resource.source.revision,
   action:resource.action,networkRequired:resource.networkRequired,buildRequired:resource.buildRequired,
   ...(resource.reason===undefined?{}:{reason:resource.reason})
  }:{
   kind:resource.kind,id:resource.id,sourceType:'localMapping',
   ...(resource.source.root===undefined?{}:{root:resource.source.root}),
   action:resource.action,networkRequired:false,buildRequired:resource.buildRequired,
   ...(resource.reason===undefined?{}:{reason:resource.reason})
  }),
  packageBuilds:{...plan.packageBuilds,unresolvedRemotePackageIds:[...plan.packageBuilds.unresolvedRemotePackageIds],warnings:[...plan.packageBuilds.warnings]},
  activeSelection:{...plan.activeSelection},
  composition:{...plan.composition,deferredLibraries:[...plan.composition.deferredLibraries],deferredPackages:[...plan.composition.deferredPackages],knownCollectionSkillPreview:[...plan.composition.knownCollectionSkillPreview]},
  exclusions:{...plan.exclusions},
  profileAction:plan.profileAction,
  blockers:plan.blockers.map((blocker)=>({...blocker}))
 };
}

export function profileImportDryRunResult(plan: ProfileImportPlan): Record<string, unknown> {
 return {mode:'dry-run',plan:profileImportPlanResult(plan)};
}

export function profileImportExecutionResult(result: ProfileImportResult): Record<string, unknown> {
 return {
  mode:'executed',plan:profileImportPlanResult(result.plan),
  resources:result.resources.map((resource)=>({...resource})),
  profileOutcome:result.profileOutcome,destinationPath:result.destinationPath,
  activeSelectionChanged:result.activeSelectionChanged,
  packageBuildReports:(result.packageBuildReports??[]).map(packageBuildReportResult),
  possibleNonrollbackablePackageEffects:[...(result.possibleNonrollbackablePackageEffects??[])]
 };
}

export function profileImportPartialResult(result: ProfileImportPartialResult): Record<string, unknown> {
 return {
  mode:'partial',plan:profileImportPlanResult(result.plan),
  resources:result.resources.map((resource)=>({...resource})),
  profileOutcome:result.profileOutcome,destinationPath:result.destinationPath,
  activeSelectionChanged:result.activeSelectionChanged,
  packageBuildReports:(result.packageBuildReports??[]).map(packageBuildReportResult),
  possibleNonrollbackablePackageEffects:[...(result.possibleNonrollbackablePackageEffects??[])]
 };
}

function packageBuildReportResult(report: PackageBuildAuthorizationReport): Record<string, unknown> {
 const source=report.source.type==='remoteGit'?{
  type:'remoteGit',remote:report.source.remote,fetchUrl:report.source.fetchUrl,
  branch:report.source.branch,revision:report.source.revision
 }:{type:'localMapping',root:report.source.root};
 return {
  packageId:report.packageId,
  source,
  ...(report.source.type==='localMapping'?{candidateRoot:report.candidateRoot,cwd:report.cwd}:{}),
  argv:[...report.argv],
  manifest:{path:report.manifest.path,sha256:report.manifest.sha256},
  artifactRoot:report.artifactRoot,
  skillsRoot:report.skillsRoot,
  shell:false,
  inheritedEnvironment:true,
  authority:{
   sandboxed:false,
   user:'current-process-user',
   access:['credentials','network','user-files']
  },
  warning:'Package build side effects are not rollbackable.'
 };
}

export function profileExportResult(result: ProfileExportResult): Record<string, unknown> {
 return {
  action:result.action,
  exportedProfileId:result.exportedProfileId,
  outputPath:result.outputPath,
  instructions:{path:result.instructions.path,digest:result.instructions.sha256},
  skills:[...result.skills],
  omittedLocalSkills:[...result.omittedLocalSkills],
  libraries:[...result.libraries],
  packages:[...result.packages],
  resources:result.resources.map(({kind,id,source})=>source.type==='remoteGit'
   ?{kind,id,sourceType:'remoteGit',remote:source.remote,fetchUrl:source.fetchUrl,branch:source.branch,revision:source.revision}
   :{kind,id,sourceType:'localMapping'})
 };
}

export function profileListResult(profileIds:readonly string[],activeProfile:string|undefined,applications:readonly SharedProfileApplicationProjection[]=[]):Record<string,unknown>{
 const activeAvailable=activeProfile!==undefined&&profileIds.includes(activeProfile);const byName=new Map(applications.map((item)=>[item.name,item]));
 return{profiles:profileIds.map((id)=>({id,active:id===activeProfile,...(byName.get(id)?.extension??{})})),active:activeProfile===undefined?{state:'unselected'}:activeAvailable?{state:'selected',profileId:activeProfile}:{state:'missing',profileId:activeProfile}};
}
export function collectionDiagnosticResult(diagnostic:SkillCollectionDiagnostic):Record<string,unknown>{
 return{category:diagnostic.category,kind:diagnostic.collectionKind,id:diagnostic.collectionId,path:diagnostic.path,...('limit'in diagnostic?{limit:diagnostic.limit}:{}),...('name'in diagnostic?{name:diagnostic.name}:{}),...('diagnosticIndex'in diagnostic?{diagnosticIndex:diagnostic.diagnosticIndex,message:diagnostic.message}:{})};
}
export function globalCollectionsResult(kind:SkillCollectionKind,inspection:{collections:GlobalSkillCollectionInspection[];diagnostics:SkillCollectionDiagnostic[]},referenceCounts:ReadonlyMap<string,number|'unknown'>,referenceDiagnostics:ReadonlyArray<{profileId:string;diagnostic:{key:{kind:SkillCollectionKind;id:string};path:string}}>):Record<string,unknown>{
 const collections=inspection.collections.filter((item)=>kindForRecord(item.record)===kind).map((item)=>{
  const record=item.record,id=idForRecord(record),count=referenceCounts.get(collectionKey(kind,id))??'unknown';
  return{kind,id,health:item.diagnostics.length===0&&count!=='unknown'?'ready':'failed',root:record.root,digest:record.digest,skillsRoot:skillsRootForRecord(record),...('package'in record?{artifactRoot:record.artifactRoot}:{}),rebuildAvailability:item.rebuildAvailability,referenceCount:count==='unknown'?null:count,skills:item.skills.map((skill)=>({name:skill.name,relativePath:skill.relativePath})),diagnostics:item.diagnostics.map(collectionDiagnosticResult)};
 });
 return{kind,collections,diagnostics:[...inspection.diagnostics.filter((item)=>item.collectionKind===kind).map(collectionDiagnosticResult),...referenceDiagnostics.filter((item)=>item.diagnostic.key.kind===kind).map((item)=>({category:'invalid-reference-index',profileId:item.profileId,kind:item.diagnostic.key.kind,id:item.diagnostic.key.id,path:item.diagnostic.path}))]};
}
export function profileCollectionsResult(profileId:string,kind:SkillCollectionKind,composition:ProfileSkillCollectionComposition):Record<string,unknown>{
 return{profileId,kind,references:composition.directCollections.filter((item)=>item.collectionKind===kind).map((item)=>({kind:item.collectionKind,id:item.collectionId,health:item.preparationState,root:item.collectionRoot??null,digest:item.snapshotDigest??null,skillsRoot:item.skillsRoot??null,rebuildAvailability:item.rebuildAvailability})),effectiveSkills:composition.derivedSkills.filter((item)=>item.collectionKind===kind).map((item)=>({name:item.name,kind:item.collectionKind,collectionId:item.collectionId,relativePath:item.relativePath})),diagnostics:composition.diagnostics.filter((item)=>item.collectionKind===kind).map(collectionDiagnosticResult)};
}
export function projectListResult(projectStates:readonly RepositoryProjectState[],currentWorktree:string|undefined,currentProjectState:RepositoryProjectState|undefined,globalPolicy:GlobalPolicy):Record<string,unknown>{
 return{globalPolicy,projects:projectStates.map((state)=>({repository:state.repository,state:state.schemaVersion===3?'enabled-override':state.schemaVersion===2?'disabled-override':'legacy-inherit',current:state.repository===currentWorktree})),current:currentWorktree===undefined?{state:'outside-git'}:{state:'git-worktree',repository:currentWorktree,override:currentProjectState===undefined?'inherit':currentProjectState.schemaVersion===3?'enabled-override':currentProjectState.schemaVersion===2?'disabled-override':'legacy-inherit'}};
}
export function statusResult(status:StatusInspection,health:'ready'|'attention'):Record<string,unknown>{
 const profile=status.profile.state!=='ready'?status.profile:{state:'ready',id:status.profile.id,instructionsPath:status.profile.instructionsPath,flatSkillCount:status.profile.flatSkillCount??status.profile.skillCount,collectionReferenceCount:status.profile.collectionReferenceCount??0,collections:(status.profile.collections??[]).map((item)=>({kind:item.collectionKind,id:item.collectionId,health:item.preparationState,root:item.collectionRoot??null,digest:item.snapshotDigest??null,skillsRoot:item.skillsRoot??null,rebuildAvailability:item.rebuildAvailability})),derivedSkills:(status.profile.derivedSkills??[]).map((item)=>({name:item.name,kind:item.collectionKind,collectionId:item.collectionId,relativePath:item.relativePath})),diagnostics:(status.profile.collectionDiagnostics??[]).map(collectionDiagnosticResult),...(status.profile.completeness===undefined?{}:{completeness:status.profile.completeness,missingResources:status.profile.missingResources??[],...(status.profile.publication===undefined?{}:{publication:status.profile.publication})})};
 return{health,bazframeHome:status.bazframeHome,piAgentDirectory:status.piAgentDirectory,adapter:{state:status.adapter.state,targetPath:status.adapter.targetPath,installedBazframeVersion:status.adapter.installedBazframeVersion??null},globalPolicy:status.globalPolicy.policy==='enabled'?{policy:'enabled',statePath:null}:{policy:'disabled',statePath:status.globalPolicy.statePath},repository:status.repository,effectiveBehavior:status.effectiveBehavior,profile,cachedCollisionAliasCount:status.cachedCollisionAliasCount,remoteGitSources:(status.managedGitProviders??[]).map(({record,health})=>({kind:record.kind,id:record.id,health,remote:record.remote,branch:record.branch,revision:record.revision,root:record.root})),remoteGitSourceDiagnostics:[...(status.managedGitDiagnostics??[])],correctiveActions:status.correctiveActions.map((item)=>({id:item.id,message:item.message}))};
}

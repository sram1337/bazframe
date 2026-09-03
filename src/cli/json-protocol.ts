import { BazframeError } from '../core/errors.js';
import { boundedTextForDisplay } from '../core/safe-text.js';
import { ProfileExportError, type ProfileExportCommitState } from '../profile-portability/profile-export.js';
import {
  ProfileImportBlockedError,
  ProfileImportExecutionError,
  ProfileImportPackageBuildAuthorizationRequiredError
} from '../profile-portability/profile-import.js';
import { profileImportPartialResult, profileImportPlanResult } from './command-results.js';
import type { Command } from './parse-argv.js';

export interface JsonDiagnostic { level: 'warning' | 'info'; code: string; message: string }
export interface JsonSuccess { schemaVersion: 1; ok: true; command: string; result: unknown; diagnostics: JsonDiagnostic[] }
export interface JsonFailure { schemaVersion: 1; ok: false; command: string; error: { category: 'usage' | 'migration' | 'unsupported' | 'operational' | 'internal'; code: string; message: string; topic?: string; commitState?: ProfileExportCommitState; outputPath?: string; plan?: Record<string, unknown>; partialResult?: Record<string, unknown> }; diagnostics: JsonDiagnostic[] }

export function commandId(command: Command): string {
  const ids: Record<Command['name'], string> = {
    'profiles-overview':'profile.list','profile-list':'profile.list','profile-current':'profile.current',
    'profile-add':'profile.add','profile-duplicate':'profile.duplicate','profile-remove':'profile.remove','profile-rename':'profile.rename','profile-use':'profile.use','profile-edit':'profile.edit','profile-export':'profile.export','profile-publish':'profile.publish','profile-import':'profile.import','profile-update':'profile.update','profile-version-list':'profile.version.list','profile-version-use':'profile.version.use',
    'skills-overview':'skill.list','default-skill-add':'skill.add','default-skill-remove':'skill.remove','skill-update':'skill.update','skill-edit':'skill.edit',
    'profile-skills-overview':'profile.skill.list','profile-skill-add':'profile.skill.add','profile-skill-remove':'profile.skill.remove',
    'libraries-overview':'library.list','libraries-add':'library.add','libraries-update':'library.update','libraries-remove':'library.remove',
    'packages-overview':'package.list','packages-add':'package.add','packages-build':'package.build','packages-update':'package.update','packages-remove':'package.remove',
    'profile-libraries-overview':'profile.library.list','profile-libraries-add':'profile.library.add','profile-libraries-remove':'profile.library.remove',
    'profile-packages-overview':'profile.package.list','profile-packages-add':'profile.package.add','profile-packages-remove':'profile.package.remove',
    'projects-overview':'project.list','project-enable':'project.enable','project-disable':'project.disable',
    'global-overview':'global.show','global-enable':'global.enable','global-disable':'global.disable',
    'adapters-overview':'adapter.list','adapter-install-pi':'adapter.install','adapter-uninstall-pi':'adapter.uninstall',
    status:'status',tui:'tui',pi:'pi'
  };
  return ids[command.name];
}

export function inferredCommandId(argv: readonly string[]): string {
  const values = argv.filter((value, index) => value !== '--json' && !(index > 0 && argv[index - 1] === '--profile'));
  const words = values.filter((value) => !value.startsWith('-')).slice(0, 3);
  const plurals:Record<string,string>={profiles:'profile',skills:'skill',libraries:'library',packages:'package',projects:'project',adapters:'adapter'};
  if(words[0] in plurals)words[0]=plurals[words[0]!]!;
  if(words[0]==='use')return'profile.use';
  if((words[0]==='add'||words[0]==='remove')&&words[1]==='skill')return`skill.${words[0]}`;
  if(words[0]==='profile'&&words[1]!==undefined&&words[1] in plurals)words[1]=plurals[words[1]]!;
  if (words[0] === 'profile' && ['skill','library','package'].includes(words[1] ?? '')) return [words[0],words[1],words[2]??'list'].join('.');
  if(words[0]==='profile'&&words[1]==='version'&&(words[2]==='list'||words[2]==='use'))return`profile.version.${words[2]}`;
  if (['profile','skill','library','package','project','global','adapter'].includes(words[0] ?? '')) return [words[0],words[1]??(words[0]==='global'?'show':'list')].join('.');
  return words[0] ?? 'unknown';
}

export function successDocument(command: string, result: unknown, diagnostics: JsonDiagnostic[] = []): JsonSuccess {
  return { schemaVersion: 1, ok: true, command, result, diagnostics: safeDiagnostics(diagnostics) };
}

export function errorDocument(command: string, error: unknown, diagnostics: JsonDiagnostic[] = []): JsonFailure {
  const safe = safeDiagnostics(diagnostics);
  if (isCliError(error)) {
    const category = error.code === 'CLI_MIGRATION_REQUIRED' ? 'migration' : error.code === 'CLI_JSON_UNSUPPORTED' ? 'unsupported' : 'usage';
    return { schemaVersion:1, ok:false, command, error:{ category, code:error.code, message:safeMessage(error.message), ...(error.topic === undefined ? {} : { topic:error.topic }) }, diagnostics:safe };
  }
  if (error instanceof ProfileExportError) return { schemaVersion:1, ok:false, command, error:{ category:'operational', code:error.code, message:safeMessage(error.message), commitState:error.commitState, outputPath:error.outputPath }, diagnostics:safe };
  if (error instanceof ProfileImportBlockedError || error instanceof ProfileImportPackageBuildAuthorizationRequiredError) return { schemaVersion:1, ok:false, command, error:{ category:'operational', code:error.code, message:safeMessage(error.message), plan:profileImportPlanResult(error.plan) }, diagnostics:safe };
  if (error instanceof ProfileImportExecutionError) return { schemaVersion:1, ok:false, command, error:{ category:'operational', code:error.code, message:safeMessage(error.message), partialResult:profileImportPartialResult(error.result) }, diagnostics:safe };
  if (error instanceof BazframeError) return { schemaVersion:1, ok:false, command, error:{ category:'operational', code:error.code, message:safeMessage(error.message) }, diagnostics:safe };
  return { schemaVersion:1, ok:false, command, error:{ category:'internal', code:'INTERNAL_ERROR', message:'Bazframe encountered an unexpected internal error.' }, diagnostics:safe };
}

export function serializeJsonDocument(document: JsonSuccess | JsonFailure): string {
  return `${JSON.stringify(document)}\n`;
}

export function cliError(code: 'CLI_USAGE'|'CLI_MIGRATION_REQUIRED'|'CLI_JSON_UNSUPPORTED', message: string, topic?: string): { code:string; message:string; topic?:string; cli:true } {
  return { code, message, ...(topic === undefined ? {} : { topic }), cli:true };
}
function isCliError(value:unknown):value is {code:'CLI_USAGE'|'CLI_MIGRATION_REQUIRED'|'CLI_JSON_UNSUPPORTED';message:string;topic?:string;cli:true}{return value!==null&&typeof value==='object'&&'cli'in value&&value.cli===true&&'code'in value&&typeof value.code==='string'&&'message'in value&&typeof value.message==='string';}
function safeMessage(value:string):string{return boundedTextForDisplay(value);}
function safeDiagnostics(diagnostics:readonly JsonDiagnostic[]):JsonDiagnostic[]{return diagnostics.map((diagnostic)=>({...diagnostic,message:safeMessage(diagnostic.message)}));}

import { assertSafeForwardedPiArgs } from '../agents/pi-args.js';
import { isAbsolute } from 'node:path';
import { BazframeError } from '../core/errors.js';
import { escapeUnsafeDisplayCharacters } from '../core/safe-text.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { isManagedGitSource } from '../providers/managed-git.js';
import { isSafeSkillId } from '../skills/skill-id.js';

export type HelpTopic =
  | 'root' | 'pi' | 'adapter' | 'status' | 'global' | 'project' | 'tui'
  | 'profile' | 'profile-add' | 'profile-duplicate' | 'profile-remove' | 'profile-rename'
  | 'profile-use' | 'profile-edit' | 'profile-export' | 'profile-import' | 'profile-list' | 'profile-current' | 'profile-skills'
  | 'profile-skills-add' | 'profile-skills-remove' | 'profile-libraries' | 'profile-libraries-add' | 'profile-libraries-remove'
  | 'profile-packages' | 'profile-packages-add' | 'profile-packages-remove'
  | 'libraries' | 'libraries-add' | 'libraries-update' | 'libraries-remove'
  | 'packages' | 'packages-add' | 'packages-build' | 'packages-update' | 'packages-remove'
  | 'skills' | 'add-skill' | 'remove-skill' | 'skill-edit' | 'skill-update';

type NoArgumentCommandName = 'profiles-overview' | 'profile-list' | 'profile-current' | 'skills-overview' | 'profile-skills-overview' | 'libraries-overview' | 'packages-overview' | 'profile-libraries-overview' | 'profile-packages-overview' | 'projects-overview' | 'global-overview' | 'adapters-overview' | 'global-enable' | 'global-disable' | 'project-enable' | 'project-disable' | 'status' | 'tui';
type NoArgumentCommand = { [Name in NoArgumentCommandName]: { name: Name } }[NoArgumentCommandName];

export type Command =
  | NoArgumentCommand
  | { name: 'profile-add' | 'profile-use' | 'profile-edit'; profileId: string }
  | { name: 'profile-export'; profileId: string; outputDirectory: string }
  | { name: 'profile-import'; artifactDirectory: string; destinationProfileId?: string; dryRun: boolean }
  | { name: 'profile-duplicate'; sourceProfileId: string; profileId: string }
  | { name: 'profile-remove'; profileId: string; force: boolean }
  | { name: 'profile-rename'; previousProfileId: string; profileId: string }
  | { name: 'default-skill-add'; skillRoot: string }
  | { name: 'default-skill-remove' | 'skill-edit'; skillId: string }
  | { name: 'skill-update'; skillId: string; acceptRewrite: boolean }
  | { name: 'libraries-add'; root: string }
  | { name: 'libraries-update'; id: string; acceptRewrite: boolean }
  | { name: 'libraries-remove'; id: string }
  | { name: 'packages-add'; root: string; yes: boolean }
  | { name: 'packages-build' | 'packages-remove'; id: string }
  | { name: 'packages-update'; id: string; acceptRewrite: boolean; yes: boolean }
  | { name: 'profile-skill-add' | 'profile-skill-remove'; skillId: string; profileId?: string }
  | { name: 'profile-libraries-add' | 'profile-libraries-remove' | 'profile-packages-add' | 'profile-packages-remove'; id: string; profileId?: string }
  | { name: 'adapter-install-pi'; force: boolean }
  | { name: 'adapter-uninstall-pi' }
  | { name: 'pi'; dryRun: boolean; forwardedArgs: string[] };

export type ParseResult =
  | { kind: 'help'; topic: HelpTopic }
  | { kind: 'version' }
  | { kind: 'command'; command: Command; json?: true }
  | { kind: 'usage-error'; message: string; topic: HelpTopic; code?: 'CLI_USAGE' | 'CLI_MIGRATION_REQUIRED' | 'CLI_JSON_UNSUPPORTED'; json?: true };

const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-v', '--version']);

export function parseArgv(input: readonly string[]): ParseResult {
  const extracted = extractJson(input);
  if (extracted.error !== undefined) return usage(extracted.error, 'root', 'CLI_USAGE', true);
  const { argv, json } = extracted;
  const result = parseCanonicalOrMigration(argv);
  if (!json) return result;
  if (result.kind === 'help' || result.kind === 'version') {
    return usage('`--json` is not supported for help or version output.', 'root', 'CLI_JSON_UNSUPPORTED', true);
  }
  if (result.kind === 'command' && ['tui', 'profile-edit', 'skill-edit', 'pi'].includes(result.command.name)) {
    return usage(`\`--json\` is not supported for \`bazframe ${displayCommand(result.command)}\`.`, topicForCommand(result.command), 'CLI_JSON_UNSUPPORTED', true);
  }
  return { ...result, json: true };
}

function extractJson(input: readonly string[]): { argv: string[]; json: boolean; error?: string } {
  const argv: string[] = [];
  let json = false;
  let afterDelimiter = false;
  for (const value of input) {
    if (afterDelimiter) { argv.push(value); continue; }
    if (value === '--') { afterDelimiter = true; argv.push(value); continue; }
    if (value === '--json') {
      if (json) return { argv, json: true, error: 'Option --json may be specified only once.' };
      json = true;
    } else argv.push(value);
  }
  return { argv, json };
}

function parseCanonicalOrMigration(argv: readonly string[]): ParseResult {
  if (argv.length === 0) return { kind: 'help', topic: 'root' };
  const [first, ...rest] = argv;
  if (first === 'help') return parseHelp(rest);
  if (HELP_FLAGS.has(first)) return rest.length === 0 ? { kind: 'help', topic: 'root' } : usage('Help flags do not accept additional arguments.', 'root');
  if (VERSION_FLAGS.has(first)) return rest.length === 0 ? { kind: 'version' } : usage('Version flags do not accept additional arguments.', 'root');

  const legacy = legacyReplacement(argv);
  if (legacy !== undefined) return migration(legacy, topicForResource(first));
  if (first === 'project' && (rest[0] === 'init' || rest[0] === 'uninit')) {
    return migration(['project', rest[0] === 'init' ? 'enable' : 'disable', ...rest.slice(1)], 'project');
  }

  switch (first) {
    case 'profile': return parseProfile(rest);
    case 'skill': return parseSkill(rest);
    case 'library': return parseCollection('library', rest);
    case 'package': return parseCollection('package', rest);
    case 'project': return parseSimpleNamespace('project', rest, ['list', 'enable', 'disable']);
    case 'global': return parseSimpleNamespace('global', rest, ['show', 'enable', 'disable']);
    case 'adapter': return parseAdapter(rest);
    case 'status': return parseNoArgs('status', rest, 'status');
    case 'tui': return parseNoArgs('tui', rest, 'tui');
    case 'pi': return parsePi(rest);
    case 'init': return migration(['project', 'enable'], 'project');
    case 'uninit': return migration(['project', 'disable'], 'project');
    default: return usage(`Unknown command: ${first}`, 'root');
  }
}

function parseHelp(args: readonly string[]): ParseResult {
  if (args.length === 0) return { kind: 'help', topic: 'root' };
  const legacy = legacyReplacement(args);
  if (legacy !== undefined) return migration(['help', ...legacy], 'root');
  const key = args.join(' ');
  const topics = new Map<string, HelpTopic>([
    ['profile','profile'], ['profile list','profile-list'], ['profile current','profile-current'], ['profile add','profile-add'], ['profile duplicate','profile-duplicate'], ['profile remove','profile-remove'], ['profile rename','profile-rename'], ['profile use','profile-use'], ['profile edit','profile-edit'], ['profile export','profile-export'], ['profile import','profile-import'],
    ['profile skill','profile-skills'], ['profile skill list','profile-skills'], ['profile skill add','profile-skills-add'], ['profile skill remove','profile-skills-remove'],
    ['profile library','profile-libraries'], ['profile library list','profile-libraries'], ['profile library add','profile-libraries-add'], ['profile library remove','profile-libraries-remove'],
    ['profile package','profile-packages'], ['profile package list','profile-packages'], ['profile package add','profile-packages-add'], ['profile package remove','profile-packages-remove'],
    ['skill','skills'], ['skill list','skills'], ['skill add','add-skill'], ['skill remove','remove-skill'], ['skill update','skill-update'], ['skill edit','skill-edit'],
    ['library','libraries'], ['library list','libraries'], ['library add','libraries-add'], ['library update','libraries-update'], ['library remove','libraries-remove'],
    ['package','packages'], ['package list','packages'], ['package add','packages-add'], ['package build','packages-build'], ['package update','packages-update'], ['package remove','packages-remove'],
    ['project','project'], ['global','global'], ['adapter','adapter'], ['status','status'], ['tui','tui'], ['pi','pi']
  ]);
  const topic = topics.get(key);
  return topic === undefined ? usage(`Unknown help topic: ${key}`, 'root') : { kind: 'help', topic };
}

function parseProfile(args: readonly string[]): ParseResult {
  if (args.length === 0) return migration(['profile', 'list'], 'profile');
  if (args.length === 1 && HELP_FLAGS.has(args[0])) return { kind: 'help', topic: 'profile' };
  const [verb, ...rest] = args;
  if (verb === 'skills' || verb === 'libraries' || verb === 'packages') return migration(['profile', singular(verb), ...(rest.length === 0 ? ['list'] : rest)], 'profile');
  if (verb === 'skill') return parseProfileMember('skill', rest);
  if (verb === 'library' || verb === 'package') return parseProfileMember(verb, rest);
  const topic = (`profile-${verb}`) as HelpTopic;
  if (rest.length === 1 && HELP_FLAGS.has(rest[0])) return { kind: 'help', topic };
  if (verb === 'list') return parseNoArgs('profile-list', rest, 'profile-list');
  if (verb === 'current') return parseNoArgs('profile-current', rest, 'profile-current');
  if (verb === 'duplicate' || verb === 'rename') {
    const operands = noOptions(rest, topic);
    if (!Array.isArray(operands)) return operands;
    if (operands.length !== 2 || operands.some((id) => !isSafeProfileId(id))) return invalidProfile(topic, `profile ${verb} requires two valid profile IDs.`);
    return verb === 'duplicate'
      ? command({ name:'profile-duplicate', sourceProfileId:operands[0]!, profileId:operands[1]! })
      : command({ name:'profile-rename', previousProfileId:operands[0]!, profileId:operands[1]! });
  }
  if (verb === 'remove') {
    const parsed = options(rest, ['force'], [], topic); if ('kind' in parsed) return parsed;
    if (parsed.operands.length !== 1 || !isSafeProfileId(parsed.operands[0]!)) return invalidProfile(topic, 'profile remove requires one valid <profile>.');
    return command({ name:'profile-remove', profileId:parsed.operands[0]!, force:parsed.booleans.has('force') });
  }
  if (verb === 'export') {
    const parsed = options(rest, [], ['output'], topic); if ('kind' in parsed) return parsed;
    if (parsed.operands.length !== 1 || !isSafeProfileId(parsed.operands[0]!)) return invalidProfile(topic, 'profile export requires one valid <profile>.');
    const outputDirectory = parsed.values.get('output');
    if (outputDirectory === undefined || outputDirectory.includes('\0')) return usage('profile export requires one nonempty --output <directory> value without NUL bytes.', topic);
    return command({ name:'profile-export', profileId:parsed.operands[0]!, outputDirectory });
  }
  if (verb === 'import') {
    const parsed = options(rest, ['dry-run'], ['as'], topic); if ('kind' in parsed) return parsed;
    if (parsed.operands.length !== 1 || parsed.operands[0]!.length === 0 || parsed.operands[0]!.includes('\0')) {
      return usage('profile import requires one nonempty <directory> value without NUL bytes.', topic);
    }
    const destinationProfileId = parsed.values.get('as');
    if (destinationProfileId !== undefined && !isSafeProfileId(destinationProfileId)) return invalidProfile(topic);
    return command({
      name: 'profile-import',
      artifactDirectory: parsed.operands[0]!,
      ...(destinationProfileId === undefined ? {} : { destinationProfileId }),
      dryRun: parsed.booleans.has('dry-run')
    });
  }
  if (verb === 'add' || verb === 'use' || verb === 'edit') {
    const operands = noOptions(rest, topic); if (!Array.isArray(operands)) return operands;
    if (operands.length !== 1) return usage(`profile ${verb} requires exactly one <profile> argument.`, topic);
    if (!isSafeProfileId(operands[0]!)) return invalidProfile(topic);
    return command({ name:`profile-${verb}` as 'profile-add'|'profile-use'|'profile-edit', profileId:operands[0]! });
  }
  return usage('profile requires `list`, `current`, `export`, `import`, a lifecycle verb, or singular `skill`, `library`, or `package`.', 'profile');
}

function parseSkill(args: readonly string[]): ParseResult {
  if (args.length === 0) return migration(['skill','list'], 'skills');
  if (args.length === 1 && HELP_FLAGS.has(args[0])) return { kind:'help', topic:'skills' };
  const [verb,...rest]=args; const topic = verb==='add'?'add-skill':verb==='remove'?'remove-skill':(`skill-${verb}` as HelpTopic);
  if (rest.length===1 && HELP_FLAGS.has(rest[0])) return {kind:'help',topic};
  if (verb==='list') return parseNoArgs('skills-overview',rest,'skills');
  if (verb==='add') {
    const operands=noOptions(rest,topic); if(!Array.isArray(operands))return operands;
    if(operands.length!==1||(!isAbsolute(operands[0]!)&&!isManagedGitSource(operands[0]!))||operands[0]!.includes('\0'))return usage('Skill input must be one absolute path or remote Git source without NUL bytes.',topic);
    return command({name:'default-skill-add',skillRoot:operands[0]!});
  }
  if (verb==='remove'||verb==='edit') {
    const operands=noOptions(rest,topic); if(!Array.isArray(operands))return operands;
    if(operands.length!==1||!isSafeSkillId(operands[0]!))return invalidSkill(topic);
    return command(verb==='remove'?{name:'default-skill-remove',skillId:operands[0]!}:{name:'skill-edit',skillId:operands[0]!});
  }
  if(verb==='update'){
    const parsed=options(rest,['accept-rewrite'],[],topic);if('kind'in parsed)return parsed;
    if(parsed.operands.length!==1||!isSafeSkillId(parsed.operands[0]!))return invalidSkill(topic);
    return command({name:'skill-update',skillId:parsed.operands[0]!,acceptRewrite:parsed.booleans.has('accept-rewrite')});
  }
  return usage('skill requires `list`, `add`, `remove`, `update`, or `edit`.', 'skills');
}

function parseCollection(kind:'library'|'package',args:readonly string[]):ParseResult{
  const plural=kind==='library'?'libraries':'packages';
  if(args.length===0)return migration([kind,'list'],plural);
  if(args.length===1&&HELP_FLAGS.has(args[0]))return{kind:'help',topic:plural};
  const [verb,...rest]=args;const topic=`${plural}-${verb}` as HelpTopic;
  if(rest.length===1&&HELP_FLAGS.has(rest[0]))return{kind:'help',topic};
  if(verb==='list')return parseNoArgs(`${plural}-overview` as Command['name'],rest,plural);
  const allowed=kind==='library'?['add','update','remove']:['add','build','update','remove'];
  if(!allowed.includes(verb))return usage(`${kind} requires ${allowed.map(x=>`\`${x}\``).join(', ')}.`,plural);
  if(verb==='add'){
    const parsed=options(rest,kind==='package'?['yes']:[],[],topic);if('kind'in parsed)return parsed;
    if(parsed.operands.length!==1)return usage(`${kind} add requires one <absolute-root-or-git-source>.`,topic);
    const root=parsed.operands[0]!;if((!isAbsolute(root)&&!isManagedGitSource(root))||root.includes('\0'))return usage(`${capitalize(kind)} input must be an absolute path or remote Git source without NUL bytes.`,topic);
    const yes=parsed.booleans.has('yes');if(yes&&isAbsolute(root))return usage('--yes applies only to package acquisition from a remote Git source.',topic);
    return command(kind==='library'?{name:'libraries-add',root}:{name:'packages-add',root,yes});
  }
  const flags=verb==='update'?(kind==='package'?['accept-rewrite','yes']:['accept-rewrite']):[];
  const parsed=options(rest,flags,[],topic);if('kind'in parsed)return parsed;
  if(parsed.operands.length!==1||!isSafeSkillId(parsed.operands[0]!))return invalidCollection(kind,topic);
  const id=parsed.operands[0]!;
  if(kind==='library')return command(verb==='update'?{name:'libraries-update',id,acceptRewrite:parsed.booleans.has('accept-rewrite')}:{name:'libraries-remove',id});
  if(verb==='update')return command({name:'packages-update',id,acceptRewrite:parsed.booleans.has('accept-rewrite'),yes:parsed.booleans.has('yes')});
  return command({name:verb==='build'?'packages-build':'packages-remove',id});
}

function parseProfileMember(kind:'skill'|'library'|'package',args:readonly string[]):ParseResult{
  const plural=kind==='skill'?'skills':kind==='library'?'libraries':'packages';
  if(args.length===0)return migration(['profile',kind,'list'],`profile-${plural}` as HelpTopic);
  if(args.length===1&&HELP_FLAGS.has(args[0]))return{kind:'help',topic:`profile-${plural}` as HelpTopic};
  const [verb,...rest]=args;const topic=(verb==='list'?`profile-${plural}`:`profile-${plural}-${verb}`) as HelpTopic;
  if(rest.length===1&&HELP_FLAGS.has(rest[0]))return{kind:'help',topic};
  if(verb==='list')return parseNoArgs(`profile-${plural}-overview` as Command['name'],rest,topic);
  if(verb!=='add'&&verb!=='remove')return usage(`profile ${kind} requires \`list\`, \`add\`, or \`remove\`.`,topic);
  const parsed=options(rest,[],['profile'],topic);if('kind'in parsed)return parsed;
  if(parsed.operands.length!==1)return usage(`profile ${kind} ${verb} requires one <${kind}>.`,topic);
  const id=parsed.operands[0]!;if(!isSafeSkillId(id))return kind==='skill'?invalidSkill(topic):invalidCollection(kind,topic);
  const profileId=parsed.values.get('profile');if(profileId!==undefined&&!isSafeProfileId(profileId))return invalidProfile(topic);
  if(kind==='skill')return command({name:`profile-skill-${verb}`,skillId:id,...(profileId===undefined?{}:{profileId})} as Command);
  return command({name:`profile-${plural}-${verb}`,id,...(profileId===undefined?{}:{profileId})} as Command);
}

function parseSimpleNamespace(kind:'project'|'global',args:readonly string[],verbs:readonly string[]):ParseResult{
  if(args.length===0)return migration([kind,kind==='global'?'show':'list'],kind);
  if(args.length===1&&HELP_FLAGS.has(args[0]))return{kind:'help',topic:kind};
  const [verb,...rest]=args;if(!verbs.includes(verb!))return usage(`${kind} requires ${verbs.map(v=>`\`${v}\``).join(', ')}.`,kind);
  const name=kind==='project'&&verb==='list'?'projects-overview':kind==='global'&&verb==='show'?'global-overview':`${kind}-${verb}`;
  return parseNoArgs(name as Command['name'],rest,kind);
}

function parseAdapter(args:readonly string[]):ParseResult{
  if(args.length===0)return migration(['adapter','list'],'adapter');
  if(args.length===1&&HELP_FLAGS.has(args[0]))return{kind:'help',topic:'adapter'};
  const [verb,...rest]=args;if(verb==='list')return parseNoArgs('adapters-overview',rest,'adapter');
  if(verb==='install'){
    const parsed=options(rest,['force'],[],'adapter');if('kind'in parsed)return parsed;
    return parsed.operands.length===1&&parsed.operands[0]==='pi'?command({name:'adapter-install-pi',force:parsed.booleans.has('force')}):usage('adapter install requires `pi`.', 'adapter');
  }
  if(verb==='uninstall')return rest.length===1&&rest[0]==='pi'?command({name:'adapter-uninstall-pi'}):usage('adapter uninstall requires `pi`.', 'adapter');
  return usage('adapter requires `list`, `install pi`, or `uninstall pi`.', 'adapter');
}

function parsePi(args:readonly string[]):ParseResult{
  if(args.length===1&&HELP_FLAGS.has(args[0]))return{kind:'help',topic:'pi'};
  let i=0,dryRun=false;if(args[i]==='--dry-run'){dryRun=true;i++;}let forwardedArgs:string[]=[];
  if(i<args.length){if(args[i]!=='--')return usage('pi accepts only --dry-run before the optional -- Pi-argument delimiter.','pi');forwardedArgs=args.slice(i+1);}
  try{assertSafeForwardedPiArgs(forwardedArgs);}catch(error){if(error instanceof BazframeError)return usage(error.message,'pi');throw error;}
  return command({name:'pi',dryRun,forwardedArgs});
}

type ParsedOptions={operands:string[];booleans:Set<string>;values:Map<string,string>};
function options(args:readonly string[],booleanNames:readonly string[],valueNames:readonly string[],topic:HelpTopic):ParsedOptions|ParseResult{
  const booleans=new Set<string>();const values=new Map<string,string>();const operands:string[]=[];
  for(let i=0;i<args.length;i++){
    const arg=args[i]!;if(!arg.startsWith('-')){operands.push(arg);continue;}
    if(arg==='--')return usage('The `--` operand delimiter is not supported for this command.',topic);
    const match=/^--([^=]+)(?:=(.*))?$/.exec(arg);if(match===null)return usage(`Unknown option: ${arg}`,topic);
    const name=match[1]!,inline=match[2];
    if(booleanNames.includes(name)){
      if(inline!==undefined)return usage(`Option --${name} does not accept a value.`,topic);
      if(booleans.has(name))return usage(`Option --${name} may be specified only once.`,topic);booleans.add(name);continue;
    }
    if(valueNames.includes(name)){
      if(values.has(name))return usage(`Option --${name} may be specified only once.`,topic);
      const value=inline!==undefined?inline:args[++i];if(value===undefined||value.length===0||value.startsWith('-'))return usage(`Option --${name} requires a value.`,topic);
      values.set(name,value);continue;
    }
    return usage(`Unknown option: ${arg}`,topic);
  }
  return{operands,booleans,values};
}
function noOptions(args:readonly string[],topic:HelpTopic):string[]|ParseResult{const parsed=options(args,[],[],topic);return'kind'in parsed?parsed:parsed.operands;}
function parseNoArgs(name:Command['name'],args:readonly string[],topic:HelpTopic):ParseResult{if(args.length===1&&HELP_FLAGS.has(args[0]))return{kind:'help',topic};return args.length===0?command({name} as Command):usage(`${displayName(name)} accepts no arguments.`,topic);}
function command(value:Command):ParseResult{return{kind:'command',command:value};}
function usage(message:string,topic:HelpTopic,code:'CLI_USAGE'|'CLI_MIGRATION_REQUIRED'|'CLI_JSON_UNSUPPORTED'='CLI_USAGE',json=false):ParseResult{return{kind:'usage-error',message,topic,code,...(json?{json:true}: {})};}
function migration(replacement:readonly string[],topic:HelpTopic):ParseResult{return usage(`This command was removed. Use \`${renderCommand(replacement)}\` instead.`,topic,'CLI_MIGRATION_REQUIRED');}
function renderCommand(args:readonly string[]):string{return['bazframe',...args].map((value)=>shellQuote(escapeUnsafeDisplayCharacters(value))).join(' ');}
function shellQuote(value:string):string{return/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)?value:`'${value.replaceAll("'",`'\\''`)}'`;}
function legacyReplacement(argv:readonly string[]):string[]|undefined{
  const [first,...rest]=argv;if(first==='profiles')return['profile',...(rest.length===0?['list']:rest)];if(first==='skills')return['skill',...(rest.length===0?['list']:rest)];if(first==='libraries')return['library',...(rest.length===0?['list']:rest)];if(first==='packages')return['package',...(rest.length===0?['list']:rest)];if(first==='projects')return['project',...(rest.length===0?['list']:rest)];if(first==='adapters')return['adapter',...(rest.length===0?['list']:rest)];
  if((first==='add'||first==='remove')&&rest[0]==='skill')return['skill',first,...rest.slice(1)];if(first==='use')return['profile','use',...rest];
  return undefined;
}
function topicForResource(value:string|undefined):HelpTopic{if(value==='profile')return'profile';if(value==='skill')return'skills';if(value==='library')return'libraries';if(value==='package')return'packages';if(value==='project')return'project';if(value==='global')return'global';if(value==='adapter')return'adapter';if(value==='status')return'status';if(value==='tui')return'tui';if(value==='pi')return'pi';return'root';}
function topicForCommand(command:Command):HelpTopic{return topicForResource(displayCommand(command).split(' ')[0]);}
function displayCommand(command:Command):string{return command.name.replace('profiles-overview','profile list').replace('skills-overview','skill list').replace('libraries-overview','library list').replace('packages-overview','package list').replace('projects-overview','project list').replace('global-overview','global show').replace('adapters-overview','adapter list').replaceAll('-',' ');}
function displayName(name:string):string{return name.replaceAll('-',' ');}
function singular(value:string):string{return value==='libraries'?'library':value==='packages'?'package':'skill';}
function capitalize(value:string):string{return value[0]!.toUpperCase()+value.slice(1);}
function invalidProfile(topic:HelpTopic,message='Profile IDs must be 1-64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.'):ParseResult{return usage(message,topic);}
function invalidSkill(topic:HelpTopic):ParseResult{return usage('Skill IDs must be 1-64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.',topic);}
function invalidCollection(kind:'library'|'package',topic:HelpTopic):ParseResult{return usage(`${capitalize(kind)} IDs must be 1-64 lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.`,topic);}

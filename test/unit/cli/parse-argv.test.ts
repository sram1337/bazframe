import { describe, expect, it } from 'vitest';
import { PROFILE_EXPORT_HELP, PROFILE_HELP, PROFILE_IMPORT_HELP, ROOT_HELP } from '../../../src/cli/help.js';
import { parseArgv } from '../../../src/cli/parse-argv.js';
import { containsUnsafeDisplayCharacters } from '../../../src/core/safe-text.js';

describe('parseArgv canonical API', () => {
  it.each([
    [['profile','list'], 'profile-list'], [['profile','current'],'profile-current'],
    [['skill','list'],'skills-overview'], [['library','list'],'libraries-overview'], [['package','list'],'packages-overview'],
    [['profile','skill','list'],'profile-skills-overview'], [['profile','library','list'],'profile-libraries-overview'], [['profile','package','list'],'profile-packages-overview'],
    [['project','list'],'projects-overview'], [['global','show'],'global-overview'], [['adapter','list'],'adapters-overview'], [['status'],'status']
  ] as const)('parses %j', (argv, name) => expect(parseArgv(argv)).toMatchObject({kind:'command',command:{name}}));

  it('parses singular lifecycle commands', () => {
    expect(parseArgv(['skill','add','/absolute/skill'])).toEqual({kind:'command',command:{name:'default-skill-add',skillRoot:'/absolute/skill'}});
    expect(parseArgv(['skill','remove','review'])).toEqual({kind:'command',command:{name:'default-skill-remove',skillId:'review'}});
    expect(parseArgv(['library','add','git:owner/tools'])).toEqual({kind:'command',command:{name:'libraries-add',root:'git:owner/tools'}});
    expect(parseArgv(['package','build','suite'])).toEqual({kind:'command',command:{name:'packages-build',id:'suite'}});
  });

  it('accepts replacement lifecycle options in either order and inline form', () => {
    expect(parseArgv(['profile','remove','--force','focused'])).toMatchObject({kind:'command',command:{force:true,profileId:'focused'}});
    expect(parseArgv(['profile','skill','add','review','--profile=other'])).toMatchObject({kind:'command',command:{profileId:'other',skillId:'review'}});
    expect(parseArgv(['profile','export','--profile','portable','--output','/tmp/export.zip','--overwrite','--bundle-remote'])).toEqual({kind:'command',command:{name:'profile-export',profileId:'portable',outputPath:'/tmp/export.zip',overwrite:true,bundleRemote:true}});
    expect(parseArgv(['profile','import','--dry-run','git:owner/repository','--commit=abc123'])).toEqual({kind:'command',command:{name:'profile-import',source:{kind:'git',value:'git:owner/repository',revision:'abc123'},dryRun:true,overwrite:false,yes:false}});
    expect(parseArgv(['--json','profile','publish','--profile=review','--public','-y'])).toEqual({kind:'command',command:{name:'profile-publish',profileId:'review',visibility:'public',bundleRemote:false,yes:true},json:true});
  });

  it.each([
    [['profile','update','--profile','portable','--overwrite'],{name:'profile-update',profileId:'portable',overwrite:true}],
    [['profile','version','list','--profile=portable'],{name:'profile-version-list',profileId:'portable'}],
    [['profile','version','use','abc123','--profile','portable','--overwrite'],{name:'profile-version-use',revision:'abc123',profileId:'portable',overwrite:true}],
    [['profile','import','archive.zip'],{name:'profile-import',source:{kind:'zip',path:'archive.zip'},dryRun:false,overwrite:false,yes:false}]
  ] as const)('parses replacement lifecycle %j',(argv,command)=>expect(parseArgv(argv)).toEqual({kind:'command',command}));

  it('accepts only bounded canonical zero-or-one-slash profile resource selectors',()=>{
    for(const [kind,field] of [['skill','skillId'],['library','id'],['package','id']] as const){
      expect(parseArgv(['profile',kind,'add','source/review'])).toMatchObject({kind:'command',command:{[field]:'source/review'}});
      for(const selector of ['source/review/extra','/review','source/','Bad/review',`${'a'.repeat(65)}/review`])expect(parseArgv(['profile',kind,'remove',selector])).toMatchObject({kind:'usage-error'});
    }
  });

  it('extracts --json globally but leaves post-Pi-delimiter data untouched', () => {
    expect(parseArgv(['--json','profile','list'])).toMatchObject({kind:'command',json:true});
    expect(parseArgv(['profile','--json','list'])).toMatchObject({kind:'command',json:true});
    expect(parseArgv(['pi','--','--json'])).toEqual({kind:'command',command:{name:'pi',dryRun:false,forwardedArgs:['--json']}});
    expect(parseArgv(['profile','list','--json','--json'])).toMatchObject({kind:'usage-error',code:'CLI_USAGE',json:true});
  });

  it('rejects unsupported interactive JSON before dispatch', () => {
    for (const argv of [['--json','tui'],['profile','edit','focused','--json'],['skill','edit','review','--json'],['pi','--json'],['--json','--version'],['--json','help']]) {
      expect(parseArgv(argv)).toMatchObject({kind:'usage-error',code:'CLI_JSON_UNSUPPORTED',json:true});
    }
  });

  it.each([
    [['profiles'], 'bazframe profile list'], [['profile'],'bazframe profile list'], [['skills'],'bazframe skill list'], [['skill'],'bazframe skill list'],
    [['libraries','add','/tmp/lib'],'bazframe library add /tmp/lib'], [['packages','build','suite'],'bazframe package build suite'],
    [['add','skill','/tmp/s'],'bazframe skill add /tmp/s'], [['remove','skill','s'],'bazframe skill remove s'],
    [['profile','skills','add','s'],'bazframe profile skill add s'], [['use','focused'],'bazframe profile use focused'],
    [['project'],'bazframe project list'], [['adapter'],'bazframe adapter list'], [['global'],'bazframe global show']
  ] as const)('rejects legacy %j with migration', (argv, replacement) => {
    const result=parseArgv(argv);expect(result).toMatchObject({kind:'usage-error',code:'CLI_MIGRATION_REQUIRED'});
    if(result.kind==='usage-error')expect(result.message).toContain(replacement);
  });

  it.each([
    ['newline','unsafe\nname','\\u000a'],
    ['ANSI escape','unsafe\u001b[31mname','\\u001b'],
    ['C1 control','unsafe\u009b31mname','\\u009b'],
    ['bidi format','unsafe\u202ename','\\u202e']
  ])('escapes %s characters in migration replacements',(_label,token,escaped)=>{
    const result=parseArgv(['libraries','add',token]);
    expect(result).toMatchObject({kind:'usage-error',code:'CLI_MIGRATION_REQUIRED'});
    if(result.kind==='usage-error'){
      expect(containsUnsafeDisplayCharacters(result.message)).toBe(false);
      expect(result.message).toContain('bazframe library add');
      expect(result.message).toContain(escaped);
      expect(result.message).toContain(`'unsafe`);
    }
  });

  it('rejects duplicate, missing, obsolete, conflicting, and malformed replacement options', () => {
    for(const argv of [
      ['profile','export','portable'],['profile','export','--profile','Bad'],['profile','export','--output',''],['profile','export','--output','a\0b'],
      ['profile','publish','--public','--private'],['profile','publish','--yes=true'],['profile','publish','extra'],
      ['profile','import'],['profile','import','one','two'],['profile','import','bad\0path'],['profile','import','archive.zip','--commit','abc'],
      ['profile','import','artifact','--as','other'],['profile','import','artifact','--map','library:x=/tmp/x'],
      ['profile','update','portable'],['profile','version','use','not-hex'],['profile','version','list','extra'],
      ['profile','version','use','abc','--overwrite','--overwrite']
    ]) expect(parseArgv(argv)).toMatchObject({kind:'usage-error'});
  });

  it('keeps --yes distinct from destructive overwrite', () => {
    expect(parseArgv(['profile','import','archive.zip','--yes'])).toMatchObject({kind:'command',command:{yes:true,overwrite:false}});
    expect(parseArgv(['profile','import','archive.zip','--overwrite'])).toMatchObject({kind:'command',command:{yes:false,overwrite:true}});
    expect(parseArgv(['profile','publish','--private'])).toMatchObject({kind:'command',command:{visibility:'private',yes:false}});
  });

  it('discovers replacement lifecycle help', () => {
    for(const [argv,topic] of [
      [['help','profile','export'],'profile-export'],[['profile','publish','--help'],'profile-publish'],
      [['help','profile','import'],'profile-import'],[['profile','update','--help'],'profile-update'],
      [['help','profile','version','list'],'profile-version-list'],[['profile','version','use','--help'],'profile-version-use']
    ] as const) expect(parseArgv(argv)).toEqual({kind:'help',topic});
    expect(PROFILE_IMPORT_HELP).toContain('<zip|git:user/repository>');
    expect(PROFILE_IMPORT_HELP).not.toContain('--as');expect(PROFILE_IMPORT_HELP).not.toContain('--map');
    expect(ROOT_HELP).toContain('profile publish');expect(PROFILE_HELP).toContain('profile version use');
    expect(PROFILE_EXPORT_HELP).toContain('[--profile <profile>]');
  });
});

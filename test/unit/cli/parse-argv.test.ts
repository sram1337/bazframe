import { describe, expect, it } from 'vitest';
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

  it('accepts known options in either order and inline option values', () => {
    expect(parseArgv(['profile','remove','--force','focused'])).toMatchObject({kind:'command',command:{force:true,profileId:'focused'}});
    expect(parseArgv(['profile','remove','focused','--force'])).toMatchObject({kind:'command',command:{force:true,profileId:'focused'}});
    expect(parseArgv(['profile','skill','add','--profile','other','review'])).toMatchObject({kind:'command',command:{profileId:'other',skillId:'review'}});
    expect(parseArgv(['profile','skill','add','review','--profile=other'])).toMatchObject({kind:'command',command:{profileId:'other',skillId:'review'}});
    expect(parseArgv(['package','update','--yes','--accept-rewrite','suite'])).toMatchObject({kind:'command',command:{yes:true,acceptRewrite:true,id:'suite'}});
    expect(parseArgv(['profile','export','portable','--output','/tmp/export'])).toEqual({kind:'command',command:{name:'profile-export',profileId:'portable',outputDirectory:'/tmp/export'}});
    expect(parseArgv(['profile','export','--output=/tmp/export','portable'])).toEqual({kind:'command',command:{name:'profile-export',profileId:'portable',outputDirectory:'/tmp/export'}});
    expect(parseArgv(['profile','import','./portable'])).toEqual({kind:'command',command:{name:'profile-import',artifactDirectory:'./portable',dryRun:false}});
    expect(parseArgv(['profile','import','--dry-run','--as=review','/tmp/portable'])).toEqual({kind:'command',command:{name:'profile-import',artifactDirectory:'/tmp/portable',destinationProfileId:'review',dryRun:true}});
    expect(parseArgv(['--json','profile','import','artifact','--as','review'])).toEqual({kind:'command',command:{name:'profile-import',artifactDirectory:'artifact',destinationProfileId:'review',dryRun:false},json:true});
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

  it('rejects duplicate, missing, valued boolean, unknown, and option-shaped operands', () => {
    for(const argv of [
      ['profile','remove','--force','--force','focused'],['profile','skill','add','--profile','review'],
      ['profile','remove','--force=true','focused'],['profile','remove','--other','focused'],['skill','remove','--bad'],
      ['profile','export','portable'],['profile','export','portable','--output',''],
      ['profile','export','portable','--output','--other'],['profile','export','portable','--output=/tmp/a','--output=/tmp/b'],
      ['profile','export','portable','--output=/tmp/a','extra'],['profile','export','--portable','--output=/tmp/a'],
      ['profile','export','portable','--output=/tmp/a\0b'],['profile','export','Bad','--output=/tmp/a'],
      ['profile','import'],['profile','import','one','two'],['profile','import','bad\0path'],
      ['profile','import','artifact','--as','Bad'],['profile','import','artifact','--as','one','--as','two'],
      ['profile','import','artifact','--dry-run','--dry-run'],['profile','import','artifact','--dry-run=true'],
      ['profile','import','artifact','--map','library:x=/tmp/x'],['profile','import','artifact','--yes'],
      ['profile','import','--artifact']
    ]) expect(parseArgv(argv)).toMatchObject({kind:'usage-error'});
  });

  it('discovers profile export and import help', () => {
    expect(parseArgv(['help','profile','export'])).toEqual({kind:'help',topic:'profile-export'});
    expect(parseArgv(['profile','export','--help'])).toEqual({kind:'help',topic:'profile-export'});
    expect(parseArgv(['help','profile','import'])).toEqual({kind:'help',topic:'profile-import'});
    expect(parseArgv(['profile','import','--help'])).toEqual({kind:'help',topic:'profile-import'});
  });
});

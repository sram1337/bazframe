import { describe, expect, it } from 'vitest';
import {
  resolveBazframeHome,
  resolvePiAgentDirectory,
  resolveSkillbookLibrary
} from '../../../src/state/paths.js';

describe('external state paths', () => {
  it('resolves Bazframe and Pi defaults from the user home', () => {
    expect(resolveBazframeHome({}, '/users/alice')).toBe('/users/alice/.bazframe');
    expect(resolvePiAgentDirectory({}, '/users/alice')).toBe('/users/alice/.pi/agent');
  });

  it('accepts normalized absolute overrides', () => {
    expect(resolveBazframeHome({ BAZFRAME_HOME: '/tmp/baz/../baz-home' }, '/ignored'))
      .toBe('/tmp/baz-home');
    expect(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: '/tmp/pi agent' }, '/ignored'))
      .toBe('/tmp/pi agent');
  });

  it('resolves Skillbook roots in canonical, deprecated, then default order', () => {
    expect(resolveSkillbookLibrary({}, '/users/alice')).toBe('/users/alice/.skillbook');
    expect(resolveSkillbookLibrary({
      SKILLBOOK_LOCK_LIBRARY: '/tmp/deprecated/../legacy'
    }, '/ignored')).toBe('/tmp/legacy');
    expect(resolveSkillbookLibrary({
      SKILLBOOK_LIBRARY: '/tmp/current',
      SKILLBOOK_LOCK_LIBRARY: '/tmp/legacy'
    }, '/ignored')).toBe('/tmp/current');
  });

  it('rejects an invalid selected Skillbook root instead of falling back', () => {
    expect(() => resolveSkillbookLibrary({
      SKILLBOOK_LIBRARY: '',
      SKILLBOOK_LOCK_LIBRARY: '/tmp/legacy'
    })).toThrow(/SKILLBOOK_LIBRARY must be a non-empty absolute path/u);
    expect(() => resolveSkillbookLibrary({ SKILLBOOK_LOCK_LIBRARY: 'relative' }))
      .toThrow(/SKILLBOOK_LOCK_LIBRARY must be an absolute path/u);
  });

  it('rejects empty, relative, and NUL-containing overrides', () => {
    expect(() => resolveBazframeHome({ BAZFRAME_HOME: '' })).toThrow(/non-empty absolute/u);
    expect(() => resolveBazframeHome({ BAZFRAME_HOME: 'relative' })).toThrow(/absolute path/u);
    expect(() => resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: '' }))
      .toThrow(/non-empty absolute/u);
    expect(() => resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: 'relative' }))
      .toThrow(/absolute path/u);
    expect(() => resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: '/tmp/pi\0bad' }))
      .toThrow(/NUL/u);
  });
});

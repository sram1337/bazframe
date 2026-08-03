import { describe, expect, it } from 'vitest';
import { decodeUtf8Instructions } from '../../../src/core/content.js';
import { composeInstructions } from '../../../src/harness/compose-instructions.js';

describe('instruction content', () => {
  it('accepts valid UTF-8 through the exact byte cap', () => {
    expect(decodeUtf8Instructions(Buffer.from('é'), 'Test', '/test', 2)).toBe('é');
  });

  it('rejects invalid UTF-8, NUL, and oversized content', () => {
    expect(() => decodeUtf8Instructions(Uint8Array.from([0xff]), 'Test', '/test'))
      .toThrow(/valid UTF-8/u);
    expect(() => decodeUtf8Instructions(Buffer.from('a\0b'), 'Test', '/test'))
      .toThrow(/NUL/u);
    expect(() => decodeUtf8Instructions(Buffer.from('abc'), 'Test', '/test', 2))
      .toThrow(/2-byte/u);
  });
});

describe('instruction composition', () => {
  it('puts visibly labeled profile instructions before repository instructions', () => {
    const effective = composeInstructions({
      profileId: 'focused',
      profile: { path: '/home/profile/instructions.md', text: 'PROFILE-RULE' },
      repository: { path: '/repo/AGENTS.md', text: 'REPOSITORY-RULE' }
    });

    expect(effective).toBe([
      '# Bazframe profile instructions: focused',
      'Source: /home/profile/instructions.md',
      '',
      'PROFILE-RULE',
      '',
      '# Bazframe repository instructions',
      'Source: /repo/AGENTS.md',
      '',
      'REPOSITORY-RULE'
    ].join('\n'));
    expect(effective.indexOf('PROFILE-RULE')).toBeLessThan(effective.indexOf('REPOSITORY-RULE'));
  });

  it('supports profile-only composition and enforces the effective cap', () => {
    const input = {
      profileId: 'focused',
      profile: { path: '/profile/instructions.md', text: 'only profile' }
    };
    expect(composeInstructions(input)).not.toContain('repository instructions');
    expect(() => composeInstructions(input, 4)).toThrow(/Composed instructions/u);
  });
});

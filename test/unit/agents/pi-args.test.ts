import { describe, expect, it } from 'vitest';
import { buildPiArgs } from '../../../src/agents/pi-args.js';

describe('Pi argv construction', () => {
  it('puts wrapper flags and additive skills before unchanged user arguments', () => {
    expect(buildPiArgs('/tmp/effective file.md', ['/skills/a', '/skills/b'], ['-p', 'hello world']))
      .toEqual([
        '--no-context-files',
        '--append-system-prompt',
        '/tmp/effective file.md',
        '--skill',
        '/skills/a',
        '--skill',
        '/skills/b',
        '-p',
        'hello world'
      ]);
  });

  it('deliberately leaves native skill discovery enabled for additive profile skills', () => {
    expect(buildPiArgs('/tmp/effective.md', [], [])).not.toContain('--no-skills');
  });
});

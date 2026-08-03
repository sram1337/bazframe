import { describe, expect, it } from 'vitest';
import { spawnPi } from '../../../src/agents/spawn-pi.js';

describe('Pi process launch', () => {
  it('reports a missing executable clearly without using a shell', async () => {
    await expect(
      spawnPi([], process.cwd(), process.env, '/definitely/missing/bazframe-test-pi')
    ).rejects.toThrow(/Could not find Pi executable/u);
  });
});

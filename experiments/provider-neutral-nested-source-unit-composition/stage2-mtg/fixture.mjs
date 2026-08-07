import { execFile } from 'node:child_process';
import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareFixture } from '../fixture.mjs';
import { resolveSourceUnit } from '../resolver.mjs';

const execute = promisify(execFile);
const stage2Root = dirname(fileURLToPath(import.meta.url));
const experimentRoot = dirname(stage2Root);
const templateRoot = join(stage2Root, 'source-template');
const sourceRepository = join(experimentRoot, '..', 'mtg-skill-refactor', 'project');
export const SOURCE_COMMIT = '55ebbf4104cc0ca80e7e907b503ca4c803107785';

const sourceInputs = Object.freeze({
  '.pi/skills/card-search/SKILL.md': 'e0e5d8f4f204333f1af818862845e9ab8e1cf09832abddab2156ae9eff44bf0b',
  '.pi/skills/deck-analysis/SKILL.md': '9ba4b6235e5053330104ad308c31cd9049b6f876696cdf9c9e29b5d471b3f317',
  '.pi/skills/deck-analysis/scorecard-and-diagnostics.md': '9943ef36469e47d692ffbc40fb2a4e2bcdc60998b0076d7b00db34f75ce80726',
  '.pi/skills/deck-analysis/scripts/scorecard.ts': '1d130a625bff937db48f546fd2eb557888ffdde2ea4cfbaf12e559acbfaa8527',
  'scripts/cards.ts': '648b250213c6a39ba4c2561fe39d2f540eb9d57a8390a78a74444dd01691d74d',
  'mtg/knowledge/deckbuilding/card-evaluation-framework.md': 'a9d5e35e9dad86a2ed3761ae8f4dba3673fd551a933f90a2b1aa950ed97bef0a',
  'mtg/knowledge/deckbuilding/synergy-support-math.md': '1feb5d2749aab85225bfe58f6c86de624262ce9e1ce4f5144459383f5106ede7',
  'package.json': '78ad9789905239a15b282d4002fa84b05e736839e2924e43c5ad97b11e887589',
  'package-lock.json': '45bd1399fc1b32ebabdc05cf0c0b866122208035718c2944cca7f810af70aeb3'
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sourceBytes(path) {
  const { stdout } = await execute(
    'git',
    ['show', `${SOURCE_COMMIT}:${path}`],
    { cwd: sourceRepository, encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 }
  );
  const actual = sha256(stdout);
  const expected = sourceInputs[path];
  if (actual !== expected) throw new Error(`Pinned source hash mismatch for ${path}: ${actual}`);
  return stdout;
}

async function populateSource({ sourceRoot }) {
  await cp(templateRoot, sourceRoot, { recursive: true, force: true });
  const sourceHashes = {};
  for (const path of Object.keys(sourceInputs)) sourceHashes[path] = sha256(await sourceBytes(path));

  const exactCopies = [
    {
      source: 'mtg/knowledge/deckbuilding/card-evaluation-framework.md',
      destination: 'shared/references/card-evaluation-framework.md'
    },
    {
      source: 'mtg/knowledge/deckbuilding/synergy-support-math.md',
      destination: 'shared/references/synergy-support-math.md'
    }
  ];
  await mkdir(join(sourceRoot, 'shared', 'references'), { recursive: true });
  for (const copy of exactCopies) {
    await writeFile(join(sourceRoot, copy.destination), await sourceBytes(copy.source));
  }

  const transformedFiles = [
    {
      destination: 'shared/cards/database.ts',
      sources: ['scripts/cards.ts'],
      note: 'Extracted explicit-input immutable JSON loading and card types; removed cache migration, writes, account identifiers, and API fallback.'
    },
    {
      destination: 'shared/cards/search.ts',
      sources: ['scripts/cards.ts'],
      note: 'Extracted deterministic pure filtering/sorting over an injected card map; removed CLI state, regex input, network, price, and cache behavior.'
    },
    {
      destination: 'deck-analysis/scripts/deck-analysis.ts',
      sources: ['.pi/skills/deck-analysis/scripts/scorecard.ts', '.pi/skills/deck-analysis/scorecard-and-diagnostics.md'],
      note: 'Replaced Archidekt/Scryfall/exec/deck-folder behavior with deterministic analysis of a synthetic immutable deck through shared modules.'
    },
    {
      destination: 'card-search/scripts/card-search.ts',
      sources: ['.pi/skills/card-search/SKILL.md', 'scripts/cards.ts'],
      note: 'Created a child-local adapter for one fixed offline search over the synthetic card fixture.'
    },
    {
      destination: 'card-search/SKILL.md',
      sources: ['.pi/skills/card-search/SKILL.md'],
      note: 'Rewrote instructions to the sanitized offline fixture and explicitly labeled direct execution as source-tree development evidence.'
    },
    {
      destination: 'deck-analysis/SKILL.md',
      sources: ['.pi/skills/deck-analysis/SKILL.md'],
      note: 'Rewrote instructions to the sanitized offline fixture and explicitly labeled direct execution as source-tree development evidence.'
    },
    {
      destination: 'package.json and package-lock.json',
      sources: ['package.json', 'package-lock.json'],
      note: 'Reduced the runtime graph to the source lock resolved tsx 4.21.0; generated a mutually consistent exact lock whose transitive versions may refresh, then provider preparation uses npm ci --ignore-scripts.'
    }
  ];
  const templateFiles = [
    'card-search/SKILL.md',
    'card-search/scripts/card-search.ts',
    'deck-analysis/SKILL.md',
    'deck-analysis/scripts/deck-analysis.ts',
    'package.json',
    'package-lock.json',
    'shared/cards/database.ts',
    'shared/cards/search.ts',
    'shared/fixtures/cards.json',
    'shared/fixtures/deck.json',
    'shared/references.ts'
  ];
  const destinationHashes = {};
  for (const path of templateFiles) destinationHashes[path] = sha256(await readFile(join(sourceRoot, path)));
  for (const copy of exactCopies) destinationHashes[copy.destination] = sourceHashes[copy.source];

  await writeFile(join(sourceRoot, 'PROVENANCE.json'), `${JSON.stringify({
    schemaVersion: 1,
    sourceCommit: SOURCE_COMMIT,
    sourceRepositoryRole: 'sanitized prior MTG experiment Git object database',
    sourceReadMethod: 'git show <commit>:<path>; current worktree bytes are never read',
    sourceHashes,
    exactCopies,
    transformedFiles,
    destinationHashes,
    exclusions: [
      'credentials', 'real decks', 'caches', 'account state', 'logs', 'networked APIs',
      'Forge', 'Moltbook', 'node_modules from the source repository', 'unrelated files'
    ]
  }, null, 2)}\n`);
}

async function setupPiHome(bazframeHome) {
  const agentDirectory = join(bazframeHome, 'pi-agent');
  const paths = [
    agentDirectory,
    join(agentDirectory, 'extensions'),
    join(bazframeHome, 'captures'),
    join(bazframeHome, 'home'),
    join(bazframeHome, 'tmp'),
    join(bazframeHome, 'xdg', 'config'),
    join(bazframeHome, 'xdg', 'cache'),
    join(bazframeHome, 'xdg', 'data'),
    join(bazframeHome, 'xdg', 'state'),
    join(bazframeHome, 'npm-cache')
  ];
  await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
  await copyFile(
    join(experimentRoot, 'pi-projection-extension.ts'),
    join(agentDirectory, 'extensions', 'source-unit-probe.ts')
  );
  await writeFile(join(agentDirectory, 'settings.json'), `${JSON.stringify({
    quietStartup: true,
    enableInstallTelemetry: false
  })}\n`);
  await writeFile(join(bazframeHome, 'home', '.gitconfig'), '[init]\n\tdefaultBranch = main\n');
}

export async function prepareStage2Fixture() {
  let preparedResolution;
  let dependencyPreparation;
  const fixture = await prepareFixture({
    providerId: 'mtg-provider',
    sourceId: 'mtg-deckbuilding',
    sourceName: 'mtg-deckbuilding',
    populate: populateSource,
    setupHome: async ({ bazframeHome, membershipPath, sourceRoot }) => {
      await setupPiHome(bazframeHome);
      preparedResolution = await resolveSourceUnit({
        providerId: 'mtg-provider',
        sourceId: 'mtg-deckbuilding',
        membershipPath
      });
      if (!preparedResolution.ok) {
        throw new Error(`Pre-install source resolution failed: ${JSON.stringify(preparedResolution)}`);
      }
      const npmCache = join(bazframeHome, 'npm-cache');
      const { stdout, stderr } = await execute(
        'npm',
        ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        {
          cwd: sourceRoot,
          encoding: 'utf8',
          env: { ...process.env, npm_config_cache: npmCache }
        }
      );
      const installedPackage = JSON.parse(await readFile(join(sourceRoot, 'node_modules', 'tsx', 'package.json'), 'utf8'));
      dependencyPreparation = {
        command: 'npm ci --ignore-scripts --no-audit --no-fund',
        completedBeforeMutationWindow: true,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        tsxVersion: installedPackage.version
      };
    }
  });
  return { ...fixture, preparedResolution, dependencyPreparation };
}

import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';

const SKILL_DEFINITION = 'SKILL.md';
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 8,
  maxEntries: 256,
  maxSkills: 64
});

class StructuralFailure extends Error {
  constructor(category, path, details = {}) {
    super(`${category}: ${path}`);
    this.category = category;
    this.path = path;
    this.details = details;
  }
}

function fail(category, path, details) {
  throw new StructuralFailure(category, path, details);
}

function isSafeId(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 64
    && SAFE_ID.test(value);
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function childPath(parent, name) {
  return parent === '.' ? name : `${parent}/${name}`;
}

function parseQuotedName(rawValue) {
  if (rawValue.startsWith("'")) {
    let value = '';
    for (let index = 1; index < rawValue.length; index += 1) {
      if (rawValue[index] !== "'") {
        value += rawValue[index];
        continue;
      }
      if (rawValue[index + 1] === "'") {
        value += "'";
        index += 1;
        continue;
      }
      if (!/^(?:\s*|\s+#.*)$/u.test(rawValue.slice(index + 1))) return null;
      return value;
    }
    return null;
  }

  if (rawValue.startsWith('"')) {
    let escaped = false;
    for (let index = 1; index < rawValue.length; index += 1) {
      const character = rawValue[index];
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        if (!/^(?:\s*|\s+#.*)$/u.test(rawValue.slice(index + 1))) return null;
        try {
          const value = JSON.parse(rawValue.slice(0, index + 1));
          return typeof value === 'string' ? value : null;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  let value = rawValue;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '#' && (index === 0 || /\s/u.test(value[index - 1] ?? ''))) {
      value = value.slice(0, index);
      break;
    }
  }
  value = value.trimEnd();
  if (value.length === 0) return null;
  if (new Set(['[', ']', '{', '&', '*', '!', '|', '>', '@', '`']).has(value[0] ?? '')) {
    return null;
  }
  if (value.startsWith('- ')) return null;
  return value;
}

async function readDeclaredName(definitionPath, relativeDefinitionPath) {
  const bytes = await readFile(definitionPath);
  let contents;
  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('invalid-definition', relativeDefinitionPath, { reason: 'definition is not UTF-8' });
  }

  const lines = contents.replace(/\r\n?/gu, '\n').split('\n');
  if (lines[0] !== '---') {
    fail('invalid-definition', relativeDefinitionPath, { reason: 'missing opening frontmatter' });
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closingIndex === -1) {
    fail('invalid-definition', relativeDefinitionPath, { reason: 'missing closing frontmatter' });
  }

  let declaredName;
  for (const line of lines.slice(1, closingIndex)) {
    if (!/^name\s*:/u.test(line)) continue;
    if (declaredName !== undefined) {
      fail('invalid-definition', relativeDefinitionPath, { reason: 'duplicate name metadata' });
    }
    declaredName = parseQuotedName(line.replace(/^name\s*:\s*/u, '').trim());
    if (declaredName === null) {
      fail('invalid-definition', relativeDefinitionPath, { reason: 'name is not a scalar string' });
    }
  }

  if (!isSafeId(declaredName)) {
    fail('invalid-definition', relativeDefinitionPath, {
      reason: 'name is not Agent Skills-compatible'
    });
  }
  return declaredName;
}

async function canonicalMembershipRoot(membershipPath) {
  try {
    const membershipStats = await lstat(membershipPath);
    if (!membershipStats.isSymbolicLink()) fail('broken-root', '.');
    const sourceRoot = await realpath(membershipPath);
    const rootStats = await lstat(sourceRoot);
    if (!rootStats.isDirectory()) fail('broken-root', '.');
    return sourceRoot;
  } catch (error) {
    if (error instanceof StructuralFailure) throw error;
    fail('broken-root', '.');
  }
}

/**
 * Resolve one experiment-local direct membership without writing any state.
 * Expected structural failures are returned; unexpected traversal I/O rejects.
 */
export async function resolveSourceUnit(input) {
  try {
    const { providerId, sourceId, membershipPath } = input;
    if (!isSafeId(providerId) || !isSafeId(sourceId)) {
      fail('invalid-definition', '.', { reason: 'invalid provider or source identity' });
    }

    const limits = { ...DEFAULT_LIMITS, ...input.limits };
    const sourceRoot = await canonicalMembershipRoot(membershipPath);
    const rootEntries = (await readdir(sourceRoot, { withFileTypes: true }))
      .sort((left, right) => compareNames(left.name, right.name));
    const rootDefinitionEntry = rootEntries.find((entry) => entry.name === SKILL_DEFINITION);
    const rootHasDefinition = rootDefinitionEntry === undefined
      ? false
      : (await lstat(join(sourceRoot, SKILL_DEFINITION))).isFile();
    const effectiveSkills = [];
    const firstDefinitionByName = new Map();
    let visitedEntries = 0;
    let skillCount = 0;

    async function visitDirectory(directoryPath, relativeDirectoryPath, depth, knownEntries) {
      const entries = knownEntries ?? (await readdir(directoryPath, { withFileTypes: true }))
        .sort((left, right) => compareNames(left.name, right.name));

      for (const entry of entries) {
        const relativeEntryPath = childPath(relativeDirectoryPath, entry.name);
        const absoluteEntryPath = join(directoryPath, entry.name);
        visitedEntries += 1;
        if (visitedEntries > limits.maxEntries) {
          fail('limit-exceeded', relativeEntryPath, {
            limit: 'entries',
            maximum: limits.maxEntries,
            observed: visitedEntries
          });
        }

        const stats = await lstat(absoluteEntryPath);
        if (stats.isSymbolicLink()) {
          fail('internal-symlink', relativeEntryPath);
        }
        if (stats.isDirectory()) {
          const childDepth = depth + 1;
          if (childDepth > limits.maxDepth) {
            fail('limit-exceeded', relativeEntryPath, {
              limit: 'depth',
              maximum: limits.maxDepth,
              observed: childDepth
            });
          }
          await visitDirectory(absoluteEntryPath, relativeEntryPath, childDepth);
          continue;
        }
        if (!stats.isFile()) {
          fail('invalid-definition', relativeEntryPath, {
            reason: 'unsupported filesystem entry type'
          });
        }
        if (entry.name !== SKILL_DEFINITION) continue;

        skillCount += 1;
        if (skillCount > limits.maxSkills) {
          fail('limit-exceeded', relativeEntryPath, {
            limit: 'skills',
            maximum: limits.maxSkills,
            observed: skillCount
          });
        }
        if (rootHasDefinition && relativeDirectoryPath !== '.') {
          fail('mixed-root', relativeEntryPath);
        }

        const declaredName = await readDeclaredName(absoluteEntryPath, relativeEntryPath);
        const expectedName = relativeDirectoryPath === '.'
          ? basename(sourceRoot)
          : basename(directoryPath);
        if (declaredName !== expectedName) {
          fail('invalid-definition', relativeEntryPath, {
            reason: 'declared name does not match skill directory',
            declaredName,
            expectedName
          });
        }

        const firstDefinitionPath = firstDefinitionByName.get(declaredName);
        if (firstDefinitionPath !== undefined) {
          fail('duplicate-name', relativeEntryPath, { declaredName, firstDefinitionPath });
        }
        firstDefinitionByName.set(declaredName, relativeEntryPath);
        effectiveSkills.push({
          providerId,
          sourceId,
          qualifiedId: `${providerId}/${sourceId}/${declaredName}`,
          sourceRoot,
          skillRoot: directoryPath,
          definitionPath: absoluteEntryPath,
          declaredName
        });
      }
    }

    await visitDirectory(sourceRoot, '.', 0, rootEntries);
    return {
      ok: true,
      directMembership: { providerId, sourceId, membershipPath, sourceRoot },
      effectiveSkills,
      counts: { visitedEntries, skills: skillCount }
    };
  } catch (error) {
    if (!(error instanceof StructuralFailure)) throw error;
    return {
      ok: false,
      error: { category: error.category, path: error.path, ...error.details }
    };
  }
}

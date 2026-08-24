import { join } from 'node:path';
import { readUtf8InstructionFile } from '../core/content.js';
import { BazframeError } from '../core/errors.js';
import { assertSafeSkillId } from './skill-id.js';

export const SKILL_DEFINITION = 'SKILL.md';

export async function readSkillDeclaredName(skillDirectory: string): Promise<string> {
  const definitionPath = join(skillDirectory, SKILL_DEFINITION);
  const contents = await readUtf8InstructionFile(definitionPath, 'Skill definition');
  return parseSkillDeclaredName(contents, definitionPath);
}

export function parseSkillDeclaredName(contents: string, definitionPath: string): string {
  const normalized = contents.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') {
    throw invalidSkillDefinition(definitionPath, 'must start with YAML frontmatter');
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closingIndex === -1) {
    throw invalidSkillDefinition(definitionPath, 'frontmatter must close with ---');
  }

  let declaredName: string | undefined;
  for (const line of lines.slice(1, closingIndex)) {
    if (!/^name\s*:/u.test(line)) continue;
    if (declaredName !== undefined) {
      throw invalidSkillDefinition(definitionPath, 'frontmatter must contain exactly one name');
    }
    const rawValue = line.replace(/^name\s*:\s*/u, '').trim();
    declaredName = parseScalarName(rawValue, definitionPath);
  }
  if (declaredName === undefined || declaredName.length === 0) {
    throw invalidSkillDefinition(definitionPath, 'frontmatter must contain a non-empty name');
  }
  try {
    assertSafeSkillId(declaredName);
  } catch (error) {
    throw new BazframeError(
      'INVALID_SKILL_DEFINITION',
      `Skill definition frontmatter name is not Agent Skills-compatible: ${definitionPath}`,
      { cause: error }
    );
  }
  return declaredName;
}

function parseScalarName(rawValue: string, definitionPath: string): string {
  if (rawValue.length === 0) {
    throw invalidSkillDefinition(definitionPath, 'frontmatter name must be a scalar string');
  }
  if (rawValue.startsWith("'")) {
    return parseSingleQuotedName(rawValue, definitionPath);
  }
  if (rawValue.startsWith('"')) {
    return parseDoubleQuotedName(rawValue, definitionPath);
  }

  const value = stripPlainScalarComment(rawValue).trimEnd();
  if (value.length === 0) {
    throw invalidSkillDefinition(definitionPath, 'frontmatter name must be a scalar string');
  }
  if (new Set(['[', ']', '{', '&', '*', '!', '|', '>', '@', '`'])
    .has(value[0] ?? '') || value.startsWith('- ')) {
    throw invalidSkillDefinition(definitionPath, 'frontmatter name must be a plain scalar string');
  }
  return value;
}

function parseSingleQuotedName(rawValue: string, definitionPath: string): string {
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
    assertOnlyTrailingComment(rawValue.slice(index + 1), definitionPath);
    return value;
  }
  throw invalidSkillDefinition(definitionPath, 'frontmatter name has an invalid quoted scalar');
}

function parseDoubleQuotedName(rawValue: string, definitionPath: string): string {
  let escaped = false;
  for (let index = 1; index < rawValue.length; index += 1) {
    const character = rawValue[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;

    assertOnlyTrailingComment(rawValue.slice(index + 1), definitionPath);
    try {
      const parsed: unknown = JSON.parse(rawValue.slice(0, index + 1));
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Report the stable definition error below.
    }
    break;
  }
  throw invalidSkillDefinition(definitionPath, 'frontmatter name has an invalid quoted scalar');
}

function assertOnlyTrailingComment(remainder: string, definitionPath: string): void {
  if (/^(?:\s*|\s+#.*)$/u.test(remainder)) return;
  throw invalidSkillDefinition(definitionPath, 'frontmatter name has an invalid quoted scalar');
}

function stripPlainScalarComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '#' && (index === 0 || /\s/u.test(value[index - 1] ?? ''))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function invalidSkillDefinition(path: string, detail: string): BazframeError {
  return new BazframeError(
    'INVALID_SKILL_DEFINITION',
    `Invalid skill definition ${path}: ${detail}.`
  );
}

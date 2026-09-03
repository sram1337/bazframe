import { BazframeError } from '../core/errors.js';
import { assertSafeSkillId } from '../skills/skill-id.js';

export interface ManagedGitSource {
  entered: string;
  remote: string;
  fetchUrl: string;
  id: string;
  githubRepository?: string;
}

export interface CanonicalRemoteGitIdentity {
  remote: string;
  fetchUrl: string;
}

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?$/u;
const GITHUB_SHORTHAND = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)$/u;

export function parseManagedGitSource(value: string): ManagedGitSource {
  if (value.length === 0 || value.includes('\u0000') || value.startsWith('-')) throw invalidSource('source is empty, option-shaped, or contains NUL');
  if (value.startsWith('git:')) return parseGitHubShorthand(value);

  if (/^[^/\s@]+@[^:]+:/u.test(value) || value.startsWith('file:')) throw invalidSource('use an HTTPS or ssh:// URL');
  let url: URL;
  try { url = new URL(value); } catch { throw invalidSource('use git:<owner>/<repository>, HTTPS, or ssh://'); }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') throw invalidSource('URL protocol must be HTTPS or ssh');
  if (url.password !== '' || (url.protocol === 'https:' && url.username !== '')) throw invalidSource('URL must not contain credentials');
  if (url.protocol === 'ssh:' && url.username !== '' && url.username !== 'git') throw invalidSource('ssh:// username must be git when present');
  if (url.search !== '' || url.hash !== '') throw invalidSource('URL query strings and fragments are not supported');
  if (url.hostname.length === 0 || url.pathname.length < 2 || url.pathname.includes('..') || url.pathname.includes('%')) throw invalidSource('URL host or repository path is invalid');
  const segments = url.pathname.replace(/^\/+|\/+$/gu, '').split('/');
  if (segments.length < 2 || segments.some((segment) => segment.length === 0 || !/^[A-Za-z0-9._~-]+$/u.test(segment))) throw invalidSource('URL must identify an owner and repository using portable path segments');
  let rawId = segments.at(-1)!.replace(/\.git$/u, '');
  if (url.hostname.toLowerCase() === 'github.com') {
    segments[0] = segments[0]!.toLowerCase();
    rawId = rawId.toLowerCase();
  }
  assertSafeSkillId(rawId);
  segments[segments.length - 1] = rawId;
  const port = url.port === '' ? '' : `:${url.port}`;
  const remote = `${url.hostname.toLowerCase()}${port}/${segments.join('/')}`;
  const username = url.protocol === 'ssh:' && url.username !== '' ? `${url.username}@` : '';
  const fetchUrl = `${url.protocol}//${username}${url.host.toLowerCase()}/${segments.join('/')}.git`;
  return { entered: value, remote, fetchUrl, id: rawId };
}

export function canonicalGitHubOrigin(value: string): string {
  if (!value.startsWith('github.com/')) throw invalidSource('GitHub origin must use github.com/<owner>/<repository>');
  const source = parseGitHubShorthand(`git:${value.slice('github.com/'.length)}`);
  if (source.remote !== value) throw invalidSource('GitHub origin is not canonical');
  return source.remote;
}

/** Canonical origin codec for profile repositories, whose GitHub names need not be Bazframe resource IDs. */
export function canonicalProfileGitHubOrigin(value: string): string {
  if (typeof value !== 'string' || !value.startsWith('github.com/')) throw invalidSource('GitHub profile origin must use github.com/<owner>/<repository>');
  const segments = value.slice('github.com/'.length).split('/');
  if (segments.length !== 2) throw invalidSource('GitHub profile origin must contain exactly owner and repository');
  const [owner, repository] = segments as [string, string];
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPOSITORY.test(repository)
    || repository === '.' || repository === '..' || repository.endsWith('.git')
    || owner !== owner.toLowerCase() || repository !== repository.toLowerCase()) {
    throw invalidSource('GitHub profile origin is not canonical');
  }
  return `github.com/${owner}/${repository}`;
}

export function normalizeManagedGitOrigin(value: string): ManagedGitSource {
  const scp = /^git@([^/:\s]+):(.+)$/u.exec(value);
  return scp === null ? parseManagedGitSource(value) : parseManagedGitSource(`ssh://git@${scp[1]}/${scp[2]}`);
}

function parseGitHubShorthand(value: string): ManagedGitSource {
  const repository = value.slice(4);
  const match = GITHUB_SHORTHAND.exec(repository);
  if (match === null) throw invalidSource('GitHub shorthand must be git:<owner>/<repository> with a Bazframe-safe repository name');
  const owner = match[1]!.toLowerCase();
  const id = match[2]!.toLowerCase();
  assertSafeSkillId(id);
  return { entered: value, remote: `github.com/${owner}/${id}`, fetchUrl: `https://github.com/${owner}/${id}.git`, id, githubRepository: `${owner}/${id}` };
}

export function canonicalManagedGitSourceForIdentity(id: string, identity: CanonicalRemoteGitIdentity): ManagedGitSource {
  assertSafeSkillId(id);
  const source = parseManagedGitSource(identity.fetchUrl);
  if (source.id !== id || source.remote !== identity.remote || source.fetchUrl !== identity.fetchUrl) {
    throw new BazframeError('MANAGED_GIT_IDENTITY_MISMATCH', `Remote Git source identity does not canonically match resource ${id}.`);
  }
  return source;
}

export function isManagedGitSource(value: string): boolean {
  return value.startsWith('git:') || value.startsWith('https://') || value.startsWith('ssh://')
    || value.startsWith('file:') || /^[^/\s@]+@[^:]+:/u.test(value);
}

function invalidSource(detail: string): BazframeError {
  return new BazframeError('MANAGED_GIT_SOURCE_INVALID', `Invalid remote Git source: ${detail}.`);
}

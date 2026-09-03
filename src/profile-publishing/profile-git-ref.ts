export function isCanonicalGitBranchName(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value === '@' || Buffer.byteLength(value, 'utf8') > 255
    || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')
    || value.includes('..') || value.includes('//') || value.includes('@{')
    || /[ ~^:?*\\[\]]/u.test(value)) return false;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point < 0x20 || point === 0x7f) return false;
  }
  return value.split('/').every((segment) => segment !== '' && !segment.startsWith('.') && !segment.endsWith('.lock'));
}

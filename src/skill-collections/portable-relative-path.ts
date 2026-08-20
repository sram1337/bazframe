export function isPortableRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) return false;
  if (value === '.') return true;
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value) || value.startsWith('//')) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

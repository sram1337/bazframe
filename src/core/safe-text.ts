export function isUnsafeDisplayCharacter(character: string): boolean {
  const code = character.codePointAt(0)!;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(character);
}

export function containsUnsafeDisplayCharacters(value: string): boolean {
  return [...value].some(isUnsafeDisplayCharacter);
}

export function replaceUnsafeDisplayCharacters(value: string, replacement: string): string {
  return [...value].map((character) => isUnsafeDisplayCharacter(character) ? replacement : character).join('');
}

export function escapeUnsafeDisplayCharacters(value: string): string {
  return [...value].map((character) => {
    if (!isUnsafeDisplayCharacter(character)) return character;
    const code = character.codePointAt(0)!;
    return code <= 0xffff
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : `\\u{${code.toString(16)}}`;
  }).join('');
}

const MAX_BOUNDED_DISPLAY_BYTES = 768;
const LONG_PATH_DISPLAY = '[path omitted: escaped display exceeds 768 UTF-8 bytes]';
const LONG_VALUE_DISPLAY = '[value omitted: escaped display exceeds 768 UTF-8 bytes]';

export function boundedTextForDisplay(value: string): string {
  const escaped = escapeUnsafeDisplayCharacters(value);
  return Buffer.byteLength(escaped, 'utf8') <= MAX_BOUNDED_DISPLAY_BYTES
    ? escaped
    : LONG_VALUE_DISPLAY;
}

/** Preserves a bounded trusted label when the escaped value cannot fit beside it. */
export function boundedPrefixedTextForDisplay(prefix: string, value: string): string {
  const escapedPrefix = escapeUnsafeDisplayCharacters(prefix);
  const escapedValue = escapeUnsafeDisplayCharacters(value);
  if (Buffer.byteLength(`${escapedPrefix}${escapedValue}`, 'utf8') <= MAX_BOUNDED_DISPLAY_BYTES) {
    return `${escapedPrefix}${escapedValue}`;
  }
  return Buffer.byteLength(`${escapedPrefix}${LONG_VALUE_DISPLAY}`, 'utf8') <= MAX_BOUNDED_DISPLAY_BYTES
    ? `${escapedPrefix}${LONG_VALUE_DISPLAY}`
    : LONG_VALUE_DISPLAY;
}

export function boundedPathForDisplay(value: string): string {
  const displayed = boundedTextForDisplay(value);
  return displayed === LONG_VALUE_DISPLAY ? LONG_PATH_DISPLAY : displayed;
}

export function stringifyForTerminal(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'undefined' : escapeUnsafeDisplayCharacters(encoded);
}

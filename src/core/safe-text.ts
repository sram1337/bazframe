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

export function stringifyForTerminal(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'undefined' : escapeUnsafeDisplayCharacters(encoded);
}

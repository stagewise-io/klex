/** Enrollment codes are `XXXX-XXXX-XXXX` without I, O, 0 or 1 (Cloud's charset). */
const CODE_CHARACTER = /[A-HJ-NP-Z2-9]/;
const COMPLETE_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

/**
 * Formats typed or pasted input as an enrollment code: upper case, grouped
 * by four, anything outside the charset dropped. Cloud hashes the exact
 * string, so the code must be normalized before it is sent.
 */
export function formatCode(input: string): string {
  const characters = [...input.toUpperCase()]
    .filter((character) => CODE_CHARACTER.test(character))
    .slice(0, 12);
  const groups: string[] = [];
  for (let index = 0; index < characters.length; index += 4) {
    groups.push(characters.slice(index, index + 4).join(''));
  }
  return groups.join('-');
}

export function isCompleteCode(code: string): boolean {
  return COMPLETE_CODE.test(code);
}

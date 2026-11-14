const displayNames = new Intl.DisplayNames(['en'], {
  type: 'language',
  fallback: 'code',
});

function languageNames(tags: readonly string[]): string[] {
  return [
    ...new Set(
      tags.map((tag) => {
        const language = new Intl.Locale(tag).language;
        return displayNames.of(language) ?? language;
      }),
    ),
  ];
}

/**
 * Appends a spoken-language rule to realtime instructions.
 *
 * Unhinted realtime models detect the language per turn, so unclear audio or
 * a text-only greeting can make them answer in an unrelated language.
 */
export function withSpokenLanguage(
  instructions: string,
  languages: readonly string[] | undefined,
): string {
  if (languages === undefined || languages.length === 0) return instructions;
  const names = languageNames(languages);
  const [primary] = names;
  const rules = [
    '## Spoken language',
    '',
    `- Start in ${primary}. Reply in the language the caller is speaking, and switch when they switch.`,
    ...(names.length > 1
      ? [`- The caller usually speaks ${names.join(' or ')}.`]
      : []),
  ];
  return `${instructions.trimEnd()}\n\n${rules.join('\n')}`;
}

/**
 * ISO-639-1 code for OpenAI transcription, which accepts only one language.
 * Several caller languages leave transcription on auto-detection so none of
 * them is transcribed as another.
 */
export function transcriptionLanguage(
  languages: readonly string[] | undefined,
): string | undefined {
  if (languages === undefined) return undefined;
  const bases = new Set(languages.map((tag) => new Intl.Locale(tag).language));
  if (bases.size !== 1) return undefined;
  const [language] = bases;
  return language?.length === 2 ? language : undefined;
}

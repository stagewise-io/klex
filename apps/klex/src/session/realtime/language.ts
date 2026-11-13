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
  const [primary, ...others] = names;
  const rules = [
    '## Spoken language',
    '',
    `- speak ${primary}. start the call in ${primary}.`,
    ...(others.length > 0
      ? [
          `- the caller may also speak ${others.join(' or ')}. answer in whichever of ${names.join(', ')} the caller last used.`,
        ]
      : []),
    `- never switch to any other language, even when audio is unclear or a transcript looks like another language. if you did not understand, ask the caller to repeat in ${primary}.`,
  ];
  return `${instructions.trimEnd()}\n\n${rules.join('\n')}`;
}

/** ISO-639-1 code of the primary language, as OpenAI transcription expects. */
export function transcriptionLanguage(
  languages: readonly string[] | undefined,
): string | undefined {
  const primary = languages?.[0];
  if (primary === undefined) return undefined;
  const language = new Intl.Locale(primary).language;
  return language.length === 2 ? language : undefined;
}

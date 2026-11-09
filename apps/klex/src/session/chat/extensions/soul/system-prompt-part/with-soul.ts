export const getSystemPromptPart = (soul: string) => {
  return `## Soul

Inside \`<soul>\` block. Describes your personality, behavioral traits, and what makes you the bot that you are.

<soul>
${soul}
</soul>`;
};

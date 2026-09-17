export const getSystemPromptPart = (soul: string) => {
  return `## Your Soul

The \`<soul>\` block contains your own thoughts about yourself. Act reliably upon it, as it describes how you view yourself and who you are.

<soul>
${soul}
</soul>`;
};

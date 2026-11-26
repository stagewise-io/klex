// Progressive enhancement: the prompt remains available in the details element.
if (!window.klexCopyAgentPromptReady) {
  window.klexCopyAgentPromptReady = true;
  const enable = () => {
    document.querySelectorAll('.copy-agent-prompt').forEach((button) => {
      button.hidden = false;
    });
  };
  document.addEventListener('astro:page-load', enable);
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', enable);
  else enable();
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('.copy-agent-prompt');
    if (!button) return;
    const status = button.nextElementSibling;
    const details = status?.nextElementSibling;
    const prompt = details?.querySelector('pre code')?.textContent?.trim();
    try {
      if (!prompt || !navigator.clipboard?.writeText)
        throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(prompt);
      status.textContent = 'Prompt copied.';
    } catch {
      if (details) details.open = true;
      status.textContent =
        'Could not copy. Select the prompt below to copy it.';
    }
  });
}

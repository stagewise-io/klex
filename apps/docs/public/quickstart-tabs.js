// Reveal the hosting panel that contains a linked heading, including old links.
// Blume's hash support selects a panel by its own ID, not a descendant's ID.
async function revealQuickstartHash() {
  await customElements.whenDefined('blume-tabs');
  const tabs = document.querySelector('.hosting-quickstart blume-tabs');
  if (!tabs || !location.hash) return;
  let id;
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    return;
  }
  const target = document.getElementById(id);
  const panel = target?.closest('[data-blume-tab-panel]');
  if (!panel || !tabs.contains(panel) || typeof tabs.activate !== 'function')
    return;
  const panels = [...tabs.querySelector('[data-blume-tab-content]').children];
  const index = panels.indexOf(panel);
  if (index < 0) return;
  const wasHidden = panel.classList.contains('hidden');
  tabs.activate(index, false, false);
  if (wasHidden) target.scrollIntoView();
}
window.addEventListener('hashchange', () =>
  queueMicrotask(revealQuickstartHash),
);
document.addEventListener('astro:page-load', revealQuickstartHash);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', revealQuickstartHash, {
    once: true,
  });
} else {
  revealQuickstartHash();
}

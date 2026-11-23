// Keep the hosting choice across pages. Blume synchronizes same-key tabs on
// one page; a linked panel or heading takes precedence over the saved choice.
if (!window.klexHostingTabsReady) {
  window.klexHostingTabsReady = true;
  const key = 'klex-docs-hosting';
  const titles = ['Cloud-hosted', 'Self-hosted'];
  const groups = () => [
    ...document.querySelectorAll('blume-tabs[data-sync-key="hosting"]'),
  ];

  function savedChoice() {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function saveChoice(title) {
    try {
      localStorage.setItem(key, title);
    } catch {
      /* storage is optional */
    }
  }
  async function restoreChoice() {
    await customElements.whenDefined('blume-tabs');
    const tabs = groups();
    let title;
    let target;
    let wasHidden = false;
    if (location.hash) {
      try {
        target = document.getElementById(
          decodeURIComponent(location.hash.slice(1)),
        );
        const panel = target?.closest('[data-blume-tab-panel]');
        if (panel && tabs.includes(panel.closest('blume-tabs'))) {
          title = panel.dataset.title;
          wasHidden = panel.classList.contains('hidden');
        }
      } catch {
        /* ignore malformed fragments */
      }
    }
    title ??= savedChoice();
    if (!titles.includes(title)) return;
    for (const tab of tabs) tab.activateByTitle?.(title, false);
    if (wasHidden) target?.scrollIntoView();
  }
  document.addEventListener('blume-tabs-change', (event) => {
    if (event.detail?.key === 'hosting' && titles.includes(event.detail.title))
      saveChoice(event.detail.title);
  });
  window.addEventListener('hashchange', restoreChoice);
  document.addEventListener('astro:page-load', restoreChoice);
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', restoreChoice, {
      once: true,
    });
  else restoreChoice();
}

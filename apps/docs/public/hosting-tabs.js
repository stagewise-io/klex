// Hosting groups use two panels in this order: Cloud-hosted, Self-hosted.
// Store canonical choices so translated labels work across pages and locales.
if (!window.klexHostingTabsReady) {
  window.klexHostingTabsReady = true;
  const key = 'klex-docs-hosting';
  const choices = ['Cloud-hosted', 'Self-hosted'];
  const groups = () => [
    ...document.querySelectorAll('blume-tabs[data-sync-key="hosting"]'),
  ];
  const panels = (group) =>
    [...group.querySelectorAll('[data-blume-tab-panel]')].filter(
      (panel) => panel.closest('blume-tabs') === group,
    );
  function activate(groups, index) {
    for (const group of groups) {
      if (panels(group).length === choices.length)
        group.activate?.(index, false, false);
    }
  }
  function savedChoice() {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function saveChoice(index) {
    try {
      localStorage.setItem(key, choices[index]);
    } catch {
      /* storage is optional */
    }
  }
  async function restoreChoice() {
    await customElements.whenDefined('blume-tabs');
    const tabs = groups();
    let index = -1;
    let target;
    let wasHidden = false;
    if (location.hash) {
      try {
        target = document.getElementById(
          decodeURIComponent(location.hash.slice(1)),
        );
        const panel = target?.closest('[data-blume-tab-panel]');
        const group = panel?.closest('blume-tabs');
        if (group && tabs.includes(group)) {
          const ownedPanels = panels(group);
          if (ownedPanels.length === choices.length) {
            index = ownedPanels.indexOf(panel);
            wasHidden = panel.classList.contains('hidden');
          }
        }
      } catch {
        /* ignore malformed fragments */
      }
    }
    if (index < 0) index = choices.indexOf(savedChoice());
    if (index < 0) return;
    activate(tabs, index);
    if (wasHidden) target?.scrollIntoView();
  }
  document.addEventListener('blume-tabs-change', (event) => {
    if (event.detail?.key !== 'hosting') return;
    const tabs = groups();
    const indices = new Set();
    for (const group of tabs) {
      const ownedPanels = panels(group);
      if (ownedPanels.length !== choices.length) continue;
      ownedPanels.forEach((panel, index) => {
        if (panel.dataset.title === event.detail.title) indices.add(index);
      });
    }
    if (indices.size !== 1) return;
    const [index] = indices;
    saveChoice(index);
    activate(tabs, index);
  });
  window.addEventListener('hashchange', restoreChoice);
  document.addEventListener('astro:page-load', restoreChoice);
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', restoreChoice, {
      once: true,
    });
  else restoreChoice();
}

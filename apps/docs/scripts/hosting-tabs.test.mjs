import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(
  new URL('../public/hosting-tabs.js', import.meta.url),
  'utf8',
);

function page(labels, storage, hash = '') {
  const listeners = new Map();
  const add = (name, fn) =>
    listeners.set(name, [...(listeners.get(name) ?? []), fn]);
  const fire = (name, detail) => {
    for (const fn of listeners.get(name) ?? []) fn({ detail });
  };
  const group = {
    selected: 0,
    querySelectorAll: () => group.panels,
    activate(index) {
      this.selected = index;
    },
  };
  group.panels = labels.map((title, index) => ({
    dataset: { title },
    closest: (selector) =>
      selector === 'blume-tabs' ? group : group.panels[index],
    classList: { contains: () => index !== group.selected },
    scrollIntoView() {},
  }));
  const document = {
    readyState: 'complete',
    addEventListener: add,
    querySelectorAll: () => [group],
    getElementById: (id) => (id === 'linked-self' ? group.panels[1] : null),
  };
  const window = { addEventListener: add };
  runInNewContext(source, {
    window,
    document,
    location: { hash },
    localStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
    },
    customElements: { whenDefined: async () => {} },
  });
  return { group, fire };
}

test('localized choices persist across locales and linked panels take precedence', async () => {
  const storage = new Map();
  const german = page(['Cloud-gehostet', 'Selbst gehostet'], storage);
  await new Promise(setImmediate);
  german.fire('blume-tabs-change', {
    key: 'hosting',
    title: 'Selbst gehostet',
  });
  assert.equal(storage.get('klex-docs-hosting'), 'Self-hosted');
  const english = page(['Cloud-hosted', 'Self-hosted'], storage);
  await new Promise(setImmediate);
  assert.equal(english.group.selected, 1);
  english.fire('blume-tabs-change', { key: 'hosting', title: 'Cloud-hosted' });
  const linked = page(
    ['Cloud-gehostet', 'Selbst gehostet'],
    storage,
    '#linked-self',
  );
  await new Promise(setImmediate);
  assert.equal(linked.group.selected, 1);
  assert.equal(storage.get('klex-docs-hosting'), 'Cloud-hosted');
  const restored = page(['Cloud-gehostet', 'Selbst gehostet'], storage);
  await new Promise(setImmediate);
  assert.equal(restored.group.selected, 0);
});

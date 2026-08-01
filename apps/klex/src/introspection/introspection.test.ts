import { describe, expect, it, vi } from 'vitest';

import { createIntrospector } from './introspection';

const noopLogger = {
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  })),
} as never;

function create() {
  return createIntrospector({ logging: noopLogger });
}

describe('Introspector — root scope', () => {
  it('has an empty path', () => {
    const intro = create();
    expect(intro.path).toEqual([]);
  });

  it('can register and read its own state', async () => {
    const intro = create();
    intro.introspect(() => ({ version: '1.0.0' }));
    const node = await intro.read([]);
    expect(node?.state).toEqual({ version: '1.0.0' });
  });

  it('returns null state when no introspect fn is registered', async () => {
    const intro = create();
    const node = await intro.read([]);
    expect(node?.state).toBeNull();
  });

  it('supports async state providers', async () => {
    const intro = create();
    intro.introspect(() => Promise.resolve({ async: true }));
    const node = await intro.read([]);
    expect(node?.state).toEqual({ async: true });
  });
});

describe('Introspector — child scopes', () => {
  it('creates a child with the correct path', () => {
    const intro = create();
    const child = intro.child('router');
    expect(child.path).toEqual(['router']);
  });

  it('can register state on a child', async () => {
    const intro = create();
    intro.child('router').introspect(() => ({ status: 'running' }));
    const node = await intro.read(['router']);
    expect(node?.state).toEqual({ status: 'running' });
    expect(node?.path).toEqual(['router']);
  });

  it('supports nested children', async () => {
    const intro = create();
    const sessions = intro.child('sessions');
    const session1 = sessions.child('sess-001');
    session1.introspect(() => ({ turns: 5 }));
    const node = await intro.read(['sessions', 'sess-001']);
    expect(node?.state).toEqual({ turns: 5 });
    expect(node?.path).toEqual(['sessions', 'sess-001']);
  });

  it('throws on duplicate child IDs', () => {
    const intro = create();
    intro.child('router');
    expect(() => intro.child('router')).toThrow(
      /Duplicate introspection child ID/,
    );
  });

  it('throws on duplicate child IDs at nested levels', () => {
    const intro = create();
    const sessions = intro.child('sessions');
    sessions.child('sess-001');
    expect(() => sessions.child('sess-001')).toThrow(
      /Duplicate introspection child ID/,
    );
  });
});

describe('Introspector — removeChild', () => {
  it('removes a child', async () => {
    const intro = create();
    intro.child('router');
    intro.removeChild('router');
    expect(await intro.read(['router'])).toBeUndefined();
  });

  it('is a no-op for a non-existent child', () => {
    const intro = create();
    expect(() => intro.removeChild('nonexistent')).not.toThrow();
  });

  it('removes the entire subtree', async () => {
    const intro = create();
    const sessions = intro.child('sessions');
    sessions.child('sess-001').introspect(() => ({ active: true }));
    intro.removeChild('sessions');
    expect(await intro.read(['sessions'])).toBeUndefined();
    expect(await intro.read(['sessions', 'sess-001'])).toBeUndefined();
  });
});

describe('Introspector — resolve', () => {
  it('resolves an existing path to a scope', () => {
    const intro = create();
    intro
      .child('sessions')
      .child('sess-001')
      .introspect(() => ({ ok: true }));
    const scope = intro.resolve(['sessions', 'sess-001']);
    expect(scope).toBeDefined();
    expect(scope?.path).toEqual(['sessions', 'sess-001']);
  });

  it('returns undefined for a non-existent path', () => {
    const intro = create();
    expect(intro.resolve(['nonexistent'])).toBeUndefined();
  });

  it('returns undefined for a partially non-existent path', () => {
    const intro = create();
    intro.child('sessions');
    expect(intro.resolve(['sessions', 'sess-999'])).toBeUndefined();
  });

  it('returns the root scope for an empty path', () => {
    const intro = create();
    const scope = intro.resolve([]);
    expect(scope).toBeDefined();
    expect(scope?.path).toEqual([]);
  });
});

describe('Introspector — read', () => {
  it('returns children info for a node (without invoking child state)', async () => {
    const intro = create();
    const sessions = intro.child('sessions');
    sessions.child('sess-001').introspect(() => ({ turns: 1 }));
    sessions.child('sess-002'); // no state, no children

    const node = await intro.read(['sessions']);
    expect(node?.children).toEqual([
      { id: 'sess-001', hasState: true, hasChildren: false },
      { id: 'sess-002', hasState: false, hasChildren: false },
    ]);
  });

  it('reflects hasChildren correctly when a child has its own children', async () => {
    const intro = create();
    const sessions = intro.child('sessions');
    const sess = sessions.child('sess-001');
    sess.child('extensions');

    const node = await intro.read(['sessions']);
    expect(node?.children[0]).toEqual({
      id: 'sess-001',
      hasState: false,
      hasChildren: true,
    });
  });

  it('returns undefined for a non-existent path', async () => {
    const intro = create();
    expect(await intro.read(['nonexistent'])).toBeUndefined();
  });

  it('returns empty children array for a leaf node', async () => {
    const intro = create();
    intro.child('router').introspect(() => ({ status: 'ok' }));
    const node = await intro.read(['router']);
    expect(node?.children).toEqual([]);
  });

  it('logs and re-throws when a state function throws', async () => {
    const intro = create();
    intro.child('failing').introspect(() => {
      throw new Error('boom');
    });
    await expect(intro.read(['failing'])).rejects.toThrow('boom');
  });
});

describe('Introspector — introspect replaces previous provider', () => {
  it('calling introspect twice replaces the state provider', async () => {
    const intro = create();
    const child = intro.child('router');
    child.introspect(() => ({ v: 1 }));
    child.introspect(() => ({ v: 2 }));
    const node = await intro.read(['router']);
    expect(node?.state).toEqual({ v: 2 });
  });
});

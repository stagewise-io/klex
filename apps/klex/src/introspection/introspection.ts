import type { ModuleLogger, RootLogger } from '@stagewise/logger';

/**
 * JSON-serializable state returned by an introspectable node.
 */
export type IntrospectionState = Record<string, unknown>;

/**
 * A function that produces the current state of an introspectable node.
 * May be sync or async. Return `null` if the node has no state to report.
 *
 * Accepts any object (interfaces, type aliases, records) — the result is
 * coerced to {@link IntrospectionState} during `read()`.
 */
export type IntrospectFn =
  | (() => object | null)
  | (() => Promise<object | null>);

/**
 * A scoped handle representing a node's position in the introspection tree.
 *
 * Every module that wants to expose state receives an `IntrospectionScope`
 * and uses it to:
 * 1. Declare its own state via {@link introspect}.
 * 2. Create child scopes for sub-modules via {@link child}.
 * 3. Remove children when they are destroyed via {@link removeChild}.
 *
 * Child IDs must be unique among siblings — registering a duplicate throws.
 */
export interface IntrospectionScope {
  /** The path segments from the root to this node (e.g. `['sessions', 'sess-001']`). */
  readonly path: readonly string[];

  /**
   * Declare this node's state provider. Called lazily when the admin API
   * requests this node's state. Calling `introspect` replaces any
   * previously registered provider.
   */
  introspect(fn: IntrospectFn): void;

  /**
   * Create a child scope with the given ID. The ID must be unique among
   * this node's current children — otherwise an error is thrown.
   */
  child(id: string): IntrospectionScope;

  /**
   * Remove a child by ID. No-op if the child does not exist.
   * The child's entire subtree is removed.
   */
  removeChild(id: string): void;
}

/**
 * Information about a direct child of an introspection node.
 */
export interface IntrospectionChildInfo {
  /** The child's ID (unique among siblings). */
  id: string;
  /** Whether the child has a registered state provider. */
  hasState: boolean;
  /** Whether the child has any children of its own. */
  hasChildren: boolean;
}

/**
 * The result of resolving a path in the introspection tree.
 */
export interface IntrospectionNode {
  /** The full path segments from root to this node. */
  path: string[];
  /** The node's state, or `null` if it has no state provider. */
  state: IntrospectionState | null;
  /** Info about the node's direct children. */
  children: IntrospectionChildInfo[];
}

/**
 * The root introspector — a registry and path resolver.
 *
 * Modules register themselves and their children hierarchically. The admin
 * API resolves paths and reads state from this tree.
 */
export interface Introspector extends IntrospectionScope {
  /**
   * Resolve a path (array of segments) to a node. Returns `undefined` if
   * any segment in the path does not exist.
   */
  resolve(path: readonly string[]): IntrospectionScope | undefined;

  /**
   * Resolve a list of raw segments — attempting longest-match at each
   * level so that child IDs containing slashes (e.g.
   * `io.stagewise/context-compaction`) are matched even when the framework
   * has already split the path on `/`.
   *
   * Returns the resolved segments and node, or `undefined` if no match.
   */
  resolveGreedy(
    segments: readonly string[],
  ): { path: string[]; node: IntrospectionScope } | undefined;

  /**
   * Read a node's full info: its own state (via the registered
   * `introspect` function) plus a listing of its direct children
   * (id, hasState, hasChildren — child state is not invoked).
   *
   * Returns `undefined` if the path does not resolve.
   */
  read(path: readonly string[]): Promise<IntrospectionNode | undefined>;

  /**
   * Read a node by greedy-resolving raw segments (see {@link resolveGreedy}).
   */
  readGreedy(
    segments: readonly string[],
  ): Promise<IntrospectionNode | undefined>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface IntrospectionNodeImpl {
  /** The function that produces this node's state, or null if none registered. */
  stateFn: IntrospectFn | null;
  /** Child nodes keyed by ID. */
  children: Map<string, IntrospectionNodeImpl>;
}

class IntrospectionScopeImpl implements IntrospectionScope {
  private readonly node: IntrospectionNodeImpl;

  constructor(
    private readonly tree: IntrospectionTree,
    private readonly segments: string[],
    node: IntrospectionNodeImpl,
  ) {
    this.node = node;
  }

  get path(): readonly string[] {
    return this.segments;
  }

  introspect(fn: IntrospectFn): void {
    this.node.stateFn = fn;
  }

  child(id: string): IntrospectionScope {
    if (this.node.children.has(id)) {
      throw new Error(
        `Duplicate introspection child ID: "${id}" — sibling IDs must be unique (parent path: ${this.segments.join('/')})`,
      );
    }
    const childNode: IntrospectionNodeImpl = {
      stateFn: null,
      children: new Map(),
    };
    this.node.children.set(id, childNode);
    return new IntrospectionScopeImpl(
      this.tree,
      [...this.segments, id],
      childNode,
    );
  }

  removeChild(id: string): void {
    this.node.children.delete(id);
  }
}

class IntrospectionTree implements Introspector {
  private readonly root: IntrospectionNodeImpl = {
    stateFn: null,
    children: new Map(),
  };

  private readonly rootScope = new IntrospectionScopeImpl(this, [], this.root);

  constructor(private readonly logger: ModuleLogger) {}

  get path(): readonly string[] {
    return this.rootScope.path;
  }

  introspect(fn: IntrospectFn): void {
    this.rootScope.introspect(fn);
  }

  child(id: string): IntrospectionScope {
    return this.rootScope.child(id);
  }

  removeChild(id: string): void {
    this.rootScope.removeChild(id);
  }

  resolve(path: readonly string[]): IntrospectionScope | undefined {
    let node = this.root;
    const segments: string[] = [];
    for (const segment of path) {
      const child = node.children.get(segment);
      if (!child) return undefined;
      segments.push(segment);
      node = child;
    }
    return new IntrospectionScopeImpl(this, segments, node);
  }

  /**
   * Greedy resolution: at each level, tries the longest possible child ID
   * by joining consecutive segments with `/`. This handles child IDs that
   * contain slashes when the framework has already split the path.
   */
  resolveGreedy(
    segments: readonly string[],
  ): { path: string[]; node: IntrospectionScope } | undefined {
    const result = this.greedyResolve(this.root, [...segments], []);
    if (!result) return undefined;
    return {
      path: result.path,
      node: new IntrospectionScopeImpl(this, result.path, result.node),
    };
  }

  private greedyResolve(
    node: IntrospectionNodeImpl,
    remaining: string[],
    resolved: string[],
  ): { path: string[]; node: IntrospectionNodeImpl } | undefined {
    if (remaining.length === 0) {
      return { path: resolved, node };
    }
    // Try longest match first: join 1..N remaining segments with `/`.
    for (let len = remaining.length; len >= 1; len--) {
      const candidate = remaining.slice(0, len).join('/');
      const child = node.children.get(candidate);
      if (child) {
        const result = this.greedyResolve(child, remaining.slice(len), [
          ...resolved,
          candidate,
        ]);
        if (result) return result;
      }
    }
    return undefined;
  }

  async read(path: readonly string[]): Promise<IntrospectionNode | undefined> {
    let node = this.root;
    const segments: string[] = [];

    for (const segment of path) {
      const child = node.children.get(segment);
      if (!child) return undefined;
      segments.push(segment);
      node = child;
    }

    return this.readNode(segments, node);
  }

  async readGreedy(
    segments: readonly string[],
  ): Promise<IntrospectionNode | undefined> {
    const resolved = this.greedyResolve(this.root, [...segments], []);
    if (!resolved) return undefined;
    return this.readNode(resolved.path, resolved.node);
  }

  /**
   * Shared state+children extraction used by both `read` and `readGreedy`.
   */
  private async readNode(
    segments: string[],
    node: IntrospectionNodeImpl,
  ): Promise<IntrospectionNode> {
    let state: IntrospectionState | null = null;
    if (node.stateFn) {
      try {
        state = (await node.stateFn()) as IntrospectionState | null;
      } catch (error) {
        this.logger.error(
          { error, path: segments.join('/') },
          'Introspection state function failed',
        );
        throw error;
      }
    }

    const children: IntrospectionChildInfo[] = [];
    for (const [id, child] of node.children) {
      children.push({
        id,
        hasState: child.stateFn !== null,
        hasChildren: child.children.size > 0,
      });
    }

    return { path: segments, state, children };
  }
}

export interface IntrospectorDependencies {
  logging: RootLogger;
}

export function createIntrospector(
  deps: IntrospectorDependencies,
): Introspector {
  return new IntrospectionTree(
    deps.logging.child({
      name: 'introspection',
      bindings: { module: 'introspection' },
    }),
  );
}

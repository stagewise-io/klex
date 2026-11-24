import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { isToolUIPart } from 'ai';

import { isDataPartOf } from '@/session/chat/extensions/extension-api';
import {
  loadMatcherSchema,
  type MemoryEntity,
} from '@/session/chat/extensions/memory/writer/entities';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

import type { LoadMatcher } from './types';

interface Evidence {
  server: string;
  value: unknown;
  tool?: string;
}
export interface Projection {
  text: string[];
  events: Evidence[];
  tools: Evidence[];
}
const normalize = (value: string) => value.normalize('NFC').toLowerCase();
export function scalarAt(value: unknown, path: string): string | null {
  for (const key of path.split('.')) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      !value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key)
    )
      return null;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
    ? String(value)
    : null;
}
function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return String(value);
  if (Array.isArray(value)) return value.map(textValue).join('\n');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const binaryBlock =
    ['image', 'audio', 'file'].includes(String(record.type)) ||
    typeof record.mimeType === 'string';
  return Object.entries(value)
    .filter(
      ([key]) =>
        !['blob', 'base64', 'memorySection', 'snapshot'].includes(key) &&
        !(binaryBlock && key === 'data'),
    )
    .map(([key, item]) => `${key}: ${textValue(item)}`)
    .join('\n');
}
export function project(message: ExtendedUIMessage): Projection {
  const result: Projection = { text: [], events: [], tools: [] };
  for (const part of message.parts) {
    if (part.type === 'text') {
      if (!/^\s*<memory(?:-update|-detail)?(?:\s|>)/iu.test(part.text))
        result.text.push(part.text);
    } else if (part.type === 'data-context') {
      if (
        part.type === 'data-context' &&
        part.data.metadata.kind === 'realtime-tool-call' &&
        [
          'readMemorySection',
          'recall',
          'recallFromMemory',
          'loadSkill',
        ].includes(String(part.data.metadata.toolName))
      )
        continue;
      for (const block of part.data.content) {
        if (block.type === 'text') result.text.push(block.text);
        if (block.type === 'resource' && block.resource.text)
          result.text.push(block.resource.text);
      }
      if (part.type === 'data-context') {
        const { origin, data } = part.data.metadata;
        if (origin === 'events' || origin === 'push-notifications') {
          result.events.push({ server: part.data.sourceEnv, value: data });
          result.text.push(textValue(data));
        }
      }
    } else if (isToolUIPart(part)) {
      const name =
        part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5);
      if (
        ![
          'readMemorySection',
          'recall',
          'recallFromMemory',
          'loadSkill',
        ].includes(name)
      ) {
        result.text.push(textValue(part.input));
        if ('output' in part) result.text.push(textValue(part.output));
        if ('errorText' in part) result.text.push(String(part.errorText));
      }
    } else if (isDataPartOf('context-summary', part)) {
      const data = (part as unknown as { data: { summary?: unknown } }).data;
      if (typeof data?.summary === 'string') result.text.push(data.summary);
    } else if (isDataPartOf('mcpInvocations', part)) {
      const data = (part as unknown as { data: unknown }).data;
      if (Array.isArray(data))
        for (const invocation of data) {
          if (
            invocation &&
            typeof invocation.namespace === 'string' &&
            typeof invocation.name === 'string'
          ) {
            result.tools.push({
              server: invocation.namespace,
              tool: invocation.name,
              value: invocation.input,
            });
            result.text.push(textValue(invocation.input));
          }
        }
    }
  }
  result.text = result.text.map(normalize);
  return result;
}
export function validMatchers(value: unknown): LoadMatcher[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = loadMatcherSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
}

/** Regex work is isolated; a valid pattern can still backtrack indefinitely. */
export interface MatcherEngine {
  readonly cacheHits: number;
  readonly compiledCacheHits: number;
  retain(projections: readonly Projection[]): void;
  match(
    projection: Projection,
    matchers: LoadMatcher[],
    entity?: MemoryEntity,
    signal?: AbortSignal,
  ): Promise<number>;
}
class MatcherEngineModule implements MatcherEngine {
  cacheHits = 0;
  compiledCacheHits = 0;
  private readonly compiled = new Map<
    string,
    { matcher: LoadMatcher; literal?: string }[]
  >();
  private readonly results = new Map<
    string,
    { tier: number; projection: string }
  >();
  private readonly disabled = new Set<string>();
  private regexQueue: Promise<unknown> = Promise.resolve();
  private worker?: Worker;
  private workerReady = false;
  private workerIdleTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly onTimeout: () => void) {}
  retain(projections: readonly Projection[]): void {
    const retained = new Set(
      projections.map((projection) =>
        createHash('sha256').update(JSON.stringify(projection)).digest('hex'),
      ),
    );
    for (const [key, result] of this.results)
      if (!retained.has(result.projection)) this.results.delete(key);
  }
  private async condition(
    value: string,
    match: string,
    pattern: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (match === 'exact') return value === pattern;
    if (match === 'glob') {
      // Whole-value wildcard matching without a backtracking regex.
      let p = 0,
        v = 0,
        star = -1,
        mark = 0;
      while (v < value.length) {
        if (pattern[p] === '?' || pattern[p] === value[v]) {
          p++;
          v++;
        } else if (pattern[p] === '*') {
          star = p++;
          mark = v;
        } else if (star >= 0) {
          p = star + 1;
          v = ++mark;
        } else return false;
      }
      while (pattern[p] === '*') p++;
      return p === pattern.length;
    }
    const result = this.regexQueue.then(() =>
      this.regex(value, pattern, signal),
    );
    this.regexQueue = result.catch(() => undefined);
    return result;
  }
  private async regex(
    value: string,
    pattern: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.disabled.has(pattern)) return false;
    signal?.throwIfAborted();
    return new Promise<boolean>((resolve, reject) => {
      clearTimeout(this.workerIdleTimer);
      const worker =
        this.worker ??
        new Worker(
          `const {parentPort}=require('node:worker_threads'); parentPort.on('message', ({pattern,value}) => { try { parentPort.postMessage(new RegExp(pattern).test(value)); } catch { parentPort.postMessage(false); } }); parentPort.postMessage('ready');`,
          {
            eval: true,
            resourceLimits: { maxOldGenerationSizeMb: 16 },
          },
        );
      this.worker = worker;
      worker.ref();
      let settled = false;
      const cleanup = (reuse = false) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        worker.removeAllListeners();
        if (reuse) {
          worker.unref();
          this.workerIdleTimer = setTimeout(() => {
            if (this.worker !== worker) return;
            this.worker = undefined;
            this.workerReady = false;
            void worker.terminate();
          }, 1000);
          this.workerIdleTimer.unref();
          worker.once('error', () => {
            if (this.worker === worker) {
              this.worker = undefined;
              this.workerReady = false;
            }
          });
        } else {
          this.worker = undefined;
          this.workerReady = false;
          void worker.terminate();
        }
      };
      const finish = (answer: boolean) => {
        if (settled) return;
        settled = true;
        cleanup(true);
        resolve(answer);
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal?.reason);
      };
      // Startup delays are infrastructure failures, not evidence of an unsafe regex.
      let timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Memory matcher worker failed to become ready'));
      }, 10000);
      worker.removeAllListeners();
      const run = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.disabled.add(pattern);
          this.onTimeout();
          if (settled) return;
          settled = true;
          cleanup();
          resolve(false);
        }, 150);
        worker.postMessage({ value, pattern });
      };
      worker.on('message', (answer) => {
        if (settled) return;
        if (answer === 'ready') {
          this.workerReady = true;
          run();
        } else finish(answer === true);
      });
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      worker.once('error', fail);
      worker.once('exit', () =>
        fail(
          new Error('Memory matcher worker exited before returning a result'),
        ),
      );
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else if (this.workerReady) run();
    });
  }
  async match(
    projection: Projection,
    matchers: LoadMatcher[],
    entity?: MemoryEntity,
    signal?: AbortSignal,
  ): Promise<number> {
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          projection,
          matchers,
          entity?.frontmatter.LinkedIdentities,
        ]),
      )
      .digest('hex');
    const cached = this.results.get(key);
    if (cached !== undefined) {
      this.cacheHits++;
      this.results.delete(key);
      this.results.set(key, cached);
      return cached.tier;
    }
    const revision = JSON.stringify(matchers);
    let compiled = this.compiled.get(revision);
    if (compiled) {
      this.compiledCacheHits++;
      this.compiled.delete(revision);
    } else {
      compiled = matchers.map((matcher) => ({
        matcher,
        ...(matcher.type === 'contentPattern'
          ? { literal: normalize(matcher.pattern) }
          : {}),
      }));
    }
    this.compiled.set(revision, compiled);
    if (this.compiled.size > 4096)
      this.compiled.delete(this.compiled.keys().next().value!);
    let tier = 0;
    if (
      entity?.frontmatter.LinkedIdentities.some((identity) =>
        [...projection.events, ...projection.tools].some(
          (evidence) =>
            evidence.server === identity.server &&
            Object.entries(identity.match).every(
              ([path, value]) => scalarAt(evidence.value, path) === value,
            ),
        ),
      )
    )
      tier = 2;
    for (const { matcher, literal } of compiled) {
      signal?.throwIfAborted();
      if (matcher.type === 'contentPattern') {
        if (projection.text.some((text) => text.includes(literal!)))
          tier = Math.max(tier, 1);
        continue;
      }
      const evidences =
        matcher.type === 'toolCallPattern'
          ? projection.tools
          : projection.events;
      const server =
        matcher.type === 'toolCallPattern' ? matcher.mcpServer : matcher.server;
      const conditions =
        matcher.type === 'toolCallPattern'
          ? matcher.arguments
          : matcher.conditions;
      for (const evidence of evidences) {
        if (
          evidence.server !== server ||
          (matcher.type === 'toolCallPattern' &&
            matcher.toolName &&
            matcher.toolName !== evidence.tool)
        )
          continue;
        let passed = true;
        for (const condition of conditions) {
          const value = scalarAt(evidence.value, condition.path);
          if (
            value === null ||
            !(await this.condition(
              value,
              condition.match,
              condition.value,
              signal,
            ))
          ) {
            passed = false;
            break;
          }
        }
        if (passed) tier = 2;
      }
    }
    this.results.set(key, {
      tier,
      projection: createHash('sha256')
        .update(JSON.stringify(projection))
        .digest('hex'),
    });
    if (this.results.size > 4096)
      this.results.delete(this.results.keys().next().value!);
    if (this.disabled.size > 4096)
      this.disabled.delete(this.disabled.values().next().value!);
    return tier;
  }
}
export function createMatcherEngine(onTimeout: () => void): MatcherEngine {
  return new MatcherEngineModule(onTimeout);
}

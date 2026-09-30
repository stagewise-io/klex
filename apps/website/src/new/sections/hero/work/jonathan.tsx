import { Code } from '@sugar-high/react';
import { useState } from 'react';

import { codeTheme, GitHubPullRequest } from '../../build';
import { typeText, usePlay, wait } from '../../workflow/stage';
import type { WorkSceneProps } from './scenes';

const changes = [
  {
    file: 'rate-limit.ts',
    code: `export function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter(
      (time) => now - time < windowMs,
    );
    hits.set(key, [...recent, now]);
    return recent.length < limit;
  };
}
`,
    repo: 'api',
    branch: 'feat/login-rate-limit',
    number: 57,
    title: 'feat(auth): rate limit login attempts',
    body: 'Blocks a client after five failed logins per minute. Adds tests for the window reset.',
  },
  {
    file: 'format-price.ts',
    code: `export function formatPrice(
  cents: number,
  currency = 'EUR',
  locale = navigator.language,
) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(cents / 100);
}
`,
    repo: 'shop',
    branch: 'fix/local-prices',
    number: 61,
    title: 'fix(checkout): show prices in local format',
    body: 'Prices used a hard-coded format. They now follow the shopper’s locale.',
  },
  {
    file: 'use-debounce.ts',
    code: `export function useDebounce<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
`,
    repo: 'dashboard',
    branch: 'perf/debounce-search',
    number: 64,
    title: 'perf(search): debounce search requests',
    body: 'Search sent a request for every key press. It now waits until typing pauses.',
  },
];

export const jonathanScene = {
  count: changes.length,
  app: () => ({
    name: 'Code',
    icon: 'vscode',
  }),
  Scene: JonathanScene,
};

type Phase = 'code' | 'compare' | 'created';

function JonathanScene({ variant, setApp, onDone }: WorkSceneProps) {
  const change = changes[variant];
  const [length, setLength] = useState(0);
  const [phase, setPhase] = useState<Phase>('code');
  const [title, setTitle] = useState('');

  usePlay(
    true,
    async (signal) => {
      await wait(500, signal);
      for (let next = 3; next < change.code.length; next += 3) {
        setLength(next);
        await wait(18, signal);
      }
      setLength(change.code.length);
      await wait(900, signal);
      setApp({ name: 'GitHub', icon: 'github' });
      setPhase('compare');
      await wait(500, signal);
      await typeText(change.title, setTitle, signal);
      await wait(500, signal);
      setPhase('created');
      await wait(1800, signal);
    },
    onDone,
  );

  if (phase === 'code')
    return (
      <div className="new-work-code">
        <Code
          lang="typescript"
          lineNumbers
          wrapLongLines={false}
          theme={codeTheme}
        >
          {change.code.slice(0, length) || ' '}
        </Code>
      </div>
    );
  return (
    <GitHubPullRequest
      title={title}
      created={phase === 'created'}
      repo={change.repo}
      branch={change.branch}
      number={change.number}
      body={change.body}
    />
  );
}

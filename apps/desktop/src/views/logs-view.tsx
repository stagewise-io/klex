import { useEffect, useRef, useState } from 'react';

import { Button } from '../components/ui/button.tsx';
import { desktop, type LogLine, onLog, subscribe } from '../lib/desktop.ts';

/** Matches the backend ring buffer, so the view never outgrows it. */
const MAX_LINES = 2000;

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

export function LogsView() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [copied, setCopied] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const unsubscribe = subscribe(
      onLog((line) =>
        setLines((current) => [...current, line].slice(-MAX_LINES)),
      ),
    );
    void desktop.logs().then(setLines);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const element = list.current;
    if (element && pinned.current && lines.length > 0) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lines]);

  const copy = async () => {
    const text = lines
      .map((line) => `${line.time} [${line.source}] ${line.message}`)
      .join('\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 pt-2">
      <div
        ref={list}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            24;
        }}
        className="min-h-0 flex-1 select-text overflow-auto rounded-lg border bg-surface-1 p-2 font-mono text-[11px] leading-4"
      >
        {lines.length === 0 ? (
          <p className="text-muted-foreground">No log lines yet.</p>
        ) : (
          lines.map((line, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: log lines carry no id
              key={index}
              className="whitespace-pre-wrap break-all"
            >
              <span className="text-muted-foreground">
                {formatTime(line.time)}{' '}
              </span>
              <span
                className={
                  line.source === 'app' ? 'text-primary' : 'text-foreground'
                }
              >
                {line.message}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy all'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void desktop.openLogFolder()}
        >
          Open log folder
        </Button>
      </div>
    </div>
  );
}

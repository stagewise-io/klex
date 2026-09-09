import { Text } from 'ink';
import type { ReactNode } from 'react';

import { InsetPanel } from './inset-panel';

export interface EmptyStateProps {
  children: ReactNode;
  tone?: 'muted' | 'warning';
  framed?: boolean;
}

export function EmptyState({
  children,
  tone = 'muted',
  framed = false,
}: EmptyStateProps) {
  const content = (
    <Text
      dimColor={tone === 'muted'}
      color={tone === 'warning' ? 'yellow' : undefined}
    >
      {children}
    </Text>
  );
  return framed ? (
    <InsetPanel tone={tone === 'warning' ? 'warning' : 'neutral'}>
      {content}
    </InsetPanel>
  ) : (
    content
  );
}

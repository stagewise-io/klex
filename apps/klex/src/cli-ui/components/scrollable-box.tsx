import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

export function scrollbarTrack(
  itemCount: number,
  selectedIndex: number,
  visibleCount = 10,
): string {
  if (itemCount <= visibleCount) return '';
  const thumbHeight = Math.max(
    1,
    Math.round((visibleCount / itemCount) * visibleCount),
  );
  const maxThumbStart = visibleCount - thumbHeight;
  const thumbStart = Math.round(
    (Math.max(0, Math.min(selectedIndex, itemCount - 1)) / (itemCount - 1)) *
      maxThumbStart,
  );
  return Array.from({ length: visibleCount }, (_, index) =>
    index >= thumbStart && index < thumbStart + thumbHeight ? '█' : '│',
  ).join('\n');
}

export function ScrollableBox({
  children,
  itemCount,
  selectedIndex = 0,
  scrollOffset,
  visibleCount = 10,
  marginTop = 1,
  bordered = true,
}: {
  children: ReactNode;
  itemCount: number;
  selectedIndex?: number;
  scrollOffset?: number;
  visibleCount?: number;
  marginTop?: number;
  bordered?: boolean;
}) {
  const trackIndex =
    scrollOffset === undefined || itemCount <= visibleCount
      ? selectedIndex
      : (Math.max(0, Math.min(scrollOffset, itemCount - visibleCount)) /
          (itemCount - visibleCount)) *
        (itemCount - 1);
  const track = scrollbarTrack(itemCount, trackIndex, visibleCount);
  return (
    <Box
      marginTop={marginTop}
      height={visibleCount + (bordered ? 2 : 0)}
      borderStyle={bordered ? 'round' : undefined}
      borderColor={bordered ? 'gray' : undefined}
      paddingX={bordered ? 1 : 0}
      overflow="hidden"
    >
      <Box flexGrow={1} overflow="hidden">
        {children}
      </Box>
      {track ? (
        <Box marginLeft={1}>
          <Text color="cyan">{track}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

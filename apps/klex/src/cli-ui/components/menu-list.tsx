import SelectInput from 'ink-select-input';
import { useState } from 'react';

import { ScrollableBox } from './scrollable-box';

export interface MenuItem<Value> {
  key?: string;
  label: string;
  value: Value;
}

export interface MenuListProps<Value> {
  items: MenuItem<Value>[];
  onSelect?: (item: MenuItem<Value>) => void;
  onHighlight?: (item: MenuItem<Value>) => void;
  initialIndex?: number;
  selectedIndex?: number;
  isFocused?: boolean;
  visibleCount?: number;
  bordered?: boolean;
}

export function MenuList<Value>({
  items,
  onSelect,
  onHighlight,
  initialIndex = 0,
  selectedIndex,
  isFocused = true,
  visibleCount,
  bordered = true,
}: MenuListProps<Value>) {
  const limit = visibleCount ?? Math.max(Math.min(items.length, 10), 1);
  const [internalIndex, setInternalIndex] = useState(initialIndex);
  const highlightedIndex = Math.max(
    0,
    Math.min(selectedIndex ?? internalIndex, Math.max(items.length - 1, 0)),
  );

  return (
    <ScrollableBox
      itemCount={items.length}
      selectedIndex={highlightedIndex}
      visibleCount={limit}
      bordered={bordered}
    >
      <SelectInput
        items={items}
        isFocused={isFocused}
        initialIndex={highlightedIndex}
        limit={limit}
        onHighlight={(item) => {
          setInternalIndex(items.indexOf(item));
          onHighlight?.(item);
        }}
        onSelect={onSelect}
      />
    </ScrollableBox>
  );
}

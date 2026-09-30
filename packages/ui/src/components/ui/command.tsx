'use client';

import {
  Command as CommandPrimitive,
  defaultFilter as defaultCommandFilter,
  useCommandState,
} from 'cmdk';
import type * as React from 'react';

import {
  IconCheckOutline18,
  IconEarthSearchOutline18,
  IconFolder5Outline18,
  IconGear3Outline18,
  IconMagnifierOutline18,
  IconMsgWritingOutline18,
} from '../../icons';
import { cn } from '../../lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { InputGroup, InputGroupAddon } from './input-group';
import { Kbd } from './kbd';
import { Separator } from './separator';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

export type CommandFilterMode = string;

export type CommandFilterTab = {
  mode: CommandFilterMode;
  label: string;
  Icon?: React.ComponentType<{
    className?: string;
    'data-icon'?: 'inline-start' | 'inline-end';
  }>;
};

const DEFAULT_FILTER_TABS: CommandFilterTab[] = [
  { mode: 'global', label: 'All' },
  { mode: 'agents', label: 'Agents', Icon: IconMsgWritingOutline18 },
  { mode: 'browser', label: 'Browser', Icon: IconEarthSearchOutline18 },
  { mode: 'files', label: 'Files', Icon: IconFolder5Outline18 },
  { mode: 'settings', label: 'Settings', Icon: IconGear3Outline18 },
];

function handleFilterKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.stopPropagation();
    return;
  }

  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.currentTarget
      .closest('[data-slot="command"]')
      ?.querySelector<HTMLInputElement>('[data-slot="command-input"]')
      ?.focus();
    return;
  }

  if (
    event.key === 'ArrowLeft' ||
    event.key === 'ArrowRight' ||
    event.key === 'Home' ||
    event.key === 'End'
  ) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex size-full flex-col overflow-hidden rounded-xl! bg-popover p-1 text-popover-foreground',
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = 'Command Palette',
  description = 'Search for a command to run...',
  children,
  className,
  showCloseButton = false,
  keepMounted = false,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, 'children'> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  keepMounted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          'top-[min(180px,25dvh)] max-h-[calc(100dvh-min(180px,25dvh)-1rem)] grid-rows-1 translate-y-0 overflow-hidden rounded-xl! p-0 sm:max-w-2xl',
          className,
        )}
        showCloseButton={showCloseButton}
        keepMounted={keepMounted}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  children,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  children?: React.ReactNode;
  variant?: 'default' | 'plain';
}) {
  const input = (
    <CommandPrimitive.Input
      data-slot="command-input"
      className={cn(
        'min-w-0 flex-1 bg-transparent text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );

  if (variant === 'plain') {
    return (
      <>
        <div
          data-slot="command-input-wrapper"
          className="flex shrink-0 items-center gap-2 px-3 py-2.5"
        >
          <IconMagnifierOutline18 className="size-4 shrink-0 text-muted-foreground" />
          {input}
          {children}
        </div>
        <Separator />
      </>
    );
  }

  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      <InputGroup className="h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
        {input}
        <InputGroupAddon>
          <IconMagnifierOutline18 className="size-4 shrink-0 opacity-50" />
        </InputGroupAddon>
        {children}
      </InputGroup>
    </div>
  );
}

function CommandFilterTabs({
  tabs = DEFAULT_FILTER_TABS,
  activeMode,
  onModeChange,
  className,
}: {
  tabs?: CommandFilterTab[];
  activeMode: CommandFilterMode;
  onModeChange: (mode: CommandFilterMode) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex shrink-0 items-center gap-2.5', className)}>
      <ToggleGroup
        aria-label="Command mode"
        value={[activeMode]}
        onValueChange={(modes) => {
          if (modes[0]) onModeChange(modes[0]);
        }}
        spacing={2.5}
      >
        {tabs.map(({ mode, label, Icon }) => (
          <ToggleGroupItem
            key={mode}
            value={mode}
            tabIndex={0}
            onKeyDown={handleFilterKeyDown}
            aria-label={label}
            title={label}
            className="h-5 min-w-0 gap-0 rounded-sm bg-transparent p-0 text-xs font-normal text-subtle-foreground transition-colors duration-150 hover:bg-transparent aria-pressed:bg-transparent aria-pressed:text-foreground"
          >
            {Icon ? (
              <>
                <Icon />
                <span className="inline-grid grid-cols-[0fr] overflow-hidden transition-[grid-template-columns,margin] duration-150 ease-out group-aria-pressed/toggle:ml-1 group-aria-pressed/toggle:grid-cols-[1fr] motion-reduce:transition-none">
                  <span className="min-w-0 overflow-hidden">{label}</span>
                </span>
              </>
            ) : (
              <span className="px-1">{label}</span>
            )}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Kbd aria-label="Press Tab to cycle filter modes">Tab</Kbd>
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        'no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none',
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn('py-6 text-center text-sm', className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('-mx-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none in-data-[slot=dialog-content]:rounded-lg! data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-muted data-[selected=true]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[selected=true]:*:[svg]:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <IconCheckOutline18 className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        'ml-auto text-xs tracking-widest text-muted-foreground group-data-[selected=true]/command-item:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandFilterTabs,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
  defaultCommandFilter,
  useCommandState,
};

import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { IconChevronDownOutline18 } from '@stagewise/ui/icons/nucleo/ui-outline-18/IconChevronDownOutline18.tsx';
import { IconMicrophone3Outline18 } from '@stagewise/ui/icons/nucleo/ui-outline-18/IconMicrophone3Outline18.tsx';
import { IconPlusOutline18 } from '@stagewise/ui/icons/nucleo/ui-outline-18/IconPlusOutline18.tsx';
import { IconVideoOutline18 } from '@stagewise/ui/icons/nucleo/ui-outline-18/IconVideoOutline18.tsx';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
} from '@stagewise/ui/src/components/ui/input-group.tsx';
import { Separator } from '@stagewise/ui/src/components/ui/separator.tsx';

const iconPaths = {
  link: 'M7 11l4-4M6 8l-2 2a3 3 0 004 4l2-2M8 6l2-2a3 3 0 014 4l-2 2',
  ordered: 'M7 4h9M7 9h9M7 14h9M2 3h1v4M2 7h2M2 11c2-2 3 0 1 2l-1 2h2',
  bullets: 'M7 4h9M7 9h9M7 14h9M2 4h1M2 9h1M2 14h1',
  quote: 'M3 3v12M6 4h10M6 9h7M6 14h10',
  code: 'M5 5L1 9l4 4M13 5l4 4-4 4M10 3L8 15',
  codeBlock: 'M5 2L2 5l3 3M13 2l3 3-3 3M10 1L8 9M2 10v5h14v-5',
  emoji: 'M16 9A7 7 0 112 9a7 7 0 0114 0M6 7h.01M12 7h.01M6 11c1.5 2 4.5 2 6 0',
  shortcuts:
    'M4 2h10a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1M12 4L6 14',
};

function SlackIcon({ name }: { name: keyof typeof iconPaths }) {
  return (
    <svg
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={iconPaths[name]} />
    </svg>
  );
}

function ToolButton({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <InputGroupButton
      size="icon-sm"
      tabIndex={-1}
      aria-label={label}
      className={className}
    >
      {children}
    </InputGroupButton>
  );
}

export function mountSlackComposer(container: HTMLElement) {
  const root = createRoot(container);
  const setDraft = (draft: string) => {
    const mention = draft.startsWith('@')
      ? draft.slice(0, '@Monica'.length)
      : '';
    root.render(
      <InputGroup>
        <div data-slot="input-group-control" className="new-slack-draft-input">
          {draft ? (
            <>
              {mention && <span className="new-slack-mention">{mention}</span>}
              {draft.slice(mention.length)}
            </>
          ) : (
            <span className="new-slack-placeholder">Message #hiring</span>
          )}
        </div>
        <InputGroupAddon align="block-start" className="new-slack-formatting">
          <ToolButton label="Bold">
            <b>B</b>
          </ToolButton>
          <ToolButton label="Italic">
            <i>I</i>
          </ToolButton>
          <ToolButton label="Underline">
            <u>U</u>
          </ToolButton>
          <ToolButton label="Strikethrough">
            <s>S</s>
          </ToolButton>
          <Separator orientation="vertical" />
          <ToolButton label="Link">
            <SlackIcon name="link" />
          </ToolButton>
          <ToolButton label="Ordered list">
            <SlackIcon name="ordered" />
          </ToolButton>
          <ToolButton label="Bulleted list">
            <SlackIcon name="bullets" />
          </ToolButton>
          <Separator
            orientation="vertical"
            className="new-slack-format-extra"
          />
          <ToolButton label="Quote" className="new-slack-format-extra">
            <SlackIcon name="quote" />
          </ToolButton>
          <ToolButton label="Code" className="new-slack-format-extra">
            <SlackIcon name="code" />
          </ToolButton>
          <ToolButton label="Code block" className="new-slack-format-extra">
            <SlackIcon name="codeBlock" />
          </ToolButton>
        </InputGroupAddon>
        <InputGroupAddon align="block-end" className="new-slack-actions">
          <ToolButton label="Attach a file" className="new-slack-attach">
            <IconPlusOutline18 />
          </ToolButton>
          <ToolButton label="Formatting">
            <span className="new-slack-format-toggle">Aa</span>
          </ToolButton>
          <ToolButton label="Emoji">
            <SlackIcon name="emoji" />
          </ToolButton>
          <ToolButton label="Mention">
            <span>@</span>
          </ToolButton>
          <Separator orientation="vertical" className="new-slack-media" />
          <ToolButton label="Record video" className="new-slack-media">
            <IconVideoOutline18 />
          </ToolButton>
          <ToolButton label="Record audio" className="new-slack-media">
            <IconMicrophone3Outline18 />
          </ToolButton>
          <Separator orientation="vertical" />
          <ToolButton label="Run a shortcut">
            <SlackIcon name="shortcuts" />
          </ToolButton>
          <InputGroupButton
            size="icon-sm"
            aria-disabled={!draft}
            tabIndex={-1}
            aria-label="Send message"
            className="new-slack-send"
            data-ready={!!draft}
          >
            <svg viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
              <path d="M2 2.5a.6.6 0 01.86-.54l13 6.5a.6.6 0 010 1.08l-13 6.5a.6.6 0 01-.84-.7L3.7 10H9V8H3.7L2.02 2.66A.6.6 0 012 2.5Z" />
            </svg>
          </InputGroupButton>
          <InputGroupButton
            size="icon-sm"
            aria-disabled={!draft}
            tabIndex={-1}
            aria-label="Send options"
            className="new-slack-send-options"
            data-ready={!!draft}
          >
            <IconChevronDownOutline18 />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>,
    );
  };
  setDraft('');
  return { setDraft, dispose: () => queueMicrotask(() => root.unmount()) };
}

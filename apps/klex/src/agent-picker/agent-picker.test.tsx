import { cleanup, render } from 'ink-testing-library';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentDirectory, DiscoveredAgent } from '@/agent-directory';
import { isDirectoryInUse } from '@/directory-lock';

import { PickerSurface } from './agent-picker';

vi.mock('@/directory-lock', () => ({ isDirectoryInUse: vi.fn() }));

const agent: DiscoveredAgent = {
  directory: '/agents/available',
  officialName: 'Available bot',
  inUse: false,
};
const longError = `Could not open agent\n  Invalid configuration\r\n\t${'detail '.repeat(50)}HIDDEN_END`;

function fixture(
  overrides: Partial<ComponentProps<typeof PickerSurface>> = {},
) {
  const agentDirectory: AgentDirectory = {
    ensureRoot: vi.fn().mockResolvedValue(undefined),
    discover: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(agent),
  };
  const props = {
    agents: [agent],
    agentDirectory,
    onComplete: vi.fn(),
    ...overrides,
  };
  const view = render(<PickerSurface {...props} />);
  return { view, props, agentDirectory };
}

async function press(view: ReturnType<typeof render>, input: string) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write(input);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function expectSingleLineError(frame: string | undefined, width: number) {
  const lines = frame?.split('\n') ?? [];
  const errorLine = lines.find((line) => line.includes('Could not open agent'));
  expect(errorLine).toContain('Could not open agent Invalid configuration');
  expect(errorLine?.length).toBeLessThanOrEqual(width);
  expect(lines.filter((line) => line.includes('detail'))).toHaveLength(1);
  expect(frame).not.toContain('HIDDEN_END');
}

beforeEach(() => {
  vi.mocked(isDirectoryInUse).mockReset().mockResolvedValue(false);
});
afterEach(cleanup);

describe('startup agent picker', () => {
  it('uses the shared header and footer without showing runtime status before a bot is selected', () => {
    const { view } = fixture();
    const lines = view.lastFrame()?.split('\n') ?? [];
    expect(lines[0]).toContain('Klex Bot');
    expect(lines[0]).toContain('Select a Klex Bot');
    expect(lines[1]).toContain('─');
    expect(lines.at(-2)).toContain('─');
    expect(lines.at(-1)).toContain('[a] Create a new Klex Bot');
    expect(lines.at(-1)).toContain('[q] Quit');
    expect(view.lastFrame()).not.toContain('0 sessions');
    expect(lines).toHaveLength(24);
  });

  it('shows an empty state and creates a bot via the hotkey, with form input owning action characters', async () => {
    const { view, props, agentDirectory } = fixture({ agents: [] });
    expect(view.lastFrame()).toContain('No Klex Bots found');
    expect(view.lastFrame()).not.toContain('[Enter] Select');
    await press(view, '\r');
    expect(agentDirectory.create).not.toHaveBeenCalled();
    expect(props.onComplete).not.toHaveBeenCalled();
    await press(view, 'A');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Agent name:'));
    expect(view.lastFrame()).toContain('Create a new Klex Bot');
    expect(view.lastFrame()).toContain('[Enter] Create');
    expect(view.lastFrame()).toContain('[Esc] Back');
    expect(view.lastFrame()).not.toContain('[q] Quit');
    await press(view, 'aqua');
    expect(props.onComplete).not.toHaveBeenCalled();
    await press(view, '\r');
    await vi.waitFor(() => {
      expect(agentDirectory.create).toHaveBeenCalledWith('aqua');
      expect(props.onComplete).toHaveBeenCalledWith(agent.directory);
    });
  });

  it('keeps creation and quitting available when every bot is unavailable', async () => {
    const { view, props } = fixture({ agents: [{ ...agent, inUse: true }] });
    await press(view, '\r');
    expect(isDirectoryInUse).not.toHaveBeenCalled();
    await press(view, 'a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Agent name:'));
    await press(view, '\u001B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[q] Quit'));
    await press(view, 'Q');
    expect(props.onComplete).toHaveBeenCalledWith(undefined);
  });
  it('uses a bounded standard list, keeps incompatible errors on one row, and blocks unavailable selection', async () => {
    const { view, props } = fixture({
      agents: [
        {
          ...agent,
          directory: '/agents/broken',
          officialName: 'Broken bot',
          compatibilityError: longError,
        },
        {
          ...agent,
          directory: '/agents/started',
          officialName: 'Started bot',
          inUse: true,
        },
        agent,
      ],
    });
    expect(view.lastFrame()).toContain('╭');
    expect(view.lastFrame()).toContain('❯ Available bot');
    expect(
      view
        .lastFrame()
        ?.split('\n')
        .filter((line) => line.includes('Broken bot')),
    ).toHaveLength(1);
    expect(view.lastFrame()).not.toContain('HIDDEN_END');
    await press(view, '1');
    await press(view, '2');
    expect(isDirectoryInUse).not.toHaveBeenCalled();
    expect(props.onComplete).not.toHaveBeenCalled();
    await press(view, '\r');
    await vi.waitFor(() =>
      expect(props.onComplete).toHaveBeenCalledWith(agent.directory),
    );
  });

  it('scrolls only bots while keeping action hotkeys in the footer within a short, narrow terminal', async () => {
    const { view, props } = fixture({
      agents: Array.from({ length: 20 }, (_, index) => ({
        ...agent,
        directory: `/agents/${index}`,
        officialName: `Bot ${index + 1}`,
      })),
    });
    Object.defineProperties(view.stdout, {
      columns: { value: 48, configurable: true },
      rows: { value: 14, configurable: true },
    });
    view.rerender(<PickerSurface {...props} />);
    await vi.waitFor(() =>
      expect(view.lastFrame()?.split('\n').length).toBeLessThanOrEqual(14),
    );
    expect(view.lastFrame()).toContain('█');
    expect(view.lastFrame()).not.toContain('Bot 20');
    for (let index = 0; index < 19; index++) await press(view, '\u001B[B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('❯ Bot 20'));
    expect(view.lastFrame()).not.toContain('❯ Create a new Klex Bot');
    expect(view.lastFrame()).not.toContain('❯ Quit');
    expect(view.lastFrame()).toContain('[a] Create a new Klex Bot');
    expect(view.lastFrame()).toContain('[q] Quit');
    expect(
      view
        .lastFrame()
        ?.split('\n')
        .every((line) => line.length <= 48),
    ).toBe(true);
    await press(view, 'q');
    expect(props.onComplete).toHaveBeenCalledWith(undefined);
  });

  it.each(
    ['preparation', 'directory check'].flatMap((failure) =>
      [64, 100].map((width) => ({ failure, width })),
    ),
  )(
    'renders a multiline $failure failure on one line at $width columns without shifting the list',
    async ({ failure, width }) => {
      const { view, props } = fixture({
        prepareAgent: vi.fn().mockRejectedValue(new Error(longError)),
      });
      Object.defineProperty(view.stdout, 'columns', {
        value: width,
        configurable: true,
      });
      view.rerender(<PickerSurface {...props} />);
      await vi.waitFor(() =>
        expect(
          view
            .lastFrame()
            ?.split('\n')
            .every((line) => line.length <= width),
        ).toBe(true),
      );
      if (failure === 'directory check')
        vi.mocked(isDirectoryInUse).mockRejectedValueOnce(new Error(longError));
      const before = view
        .lastFrame()
        ?.split('\n')
        .findIndex((line) => line.includes('╭'));
      await press(view, '\r');
      await vi.waitFor(() =>
        expect(view.lastFrame()).toContain('Could not open agent'),
      );
      expectSingleLineError(view.lastFrame(), view.stdout.columns);
      expect(
        view
          .lastFrame()
          ?.split('\n')
          .findIndex((line) => line.includes('╭')),
      ).toBe(before);
    },
  );

  it('keeps creation errors single-line and clears them on returning to the list', async () => {
    const { view, agentDirectory } = fixture({ agents: [] });
    vi.mocked(agentDirectory.create).mockRejectedValue(new Error(longError));
    await press(view, 'a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Agent name:'));
    await press(view, '\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Could not open agent'),
    );
    expectSingleLineError(view.lastFrame(), view.stdout.columns);
    await press(view, '\u001B');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('[q] Quit');
      expect(view.lastFrame()).not.toContain('Could not open agent');
    });
  });

  it('keeps cloud enrollment errors single-line', async () => {
    const { view, props } = fixture({
      prepareAgent: vi.fn().mockResolvedValue(true),
      enrollCloud: vi.fn().mockRejectedValue(new Error(longError)),
    });
    await press(view, '\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Token:'));
    expect(view.lastFrame()).toContain('Cloud enrollment');
    expect(view.lastFrame()).toContain('[Enter] Enroll');
    expect(view.lastFrame()).toContain('[Esc] Back');
    await press(view, 'test-token');
    await press(view, '\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Could not open agent'),
    );
    expectSingleLineError(view.lastFrame(), view.stdout.columns);
    expect(props.onComplete).not.toHaveBeenCalled();
  });
});

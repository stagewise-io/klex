import { type ConnectorId, resolveConnector } from './connector-registry';
import { botFixtures } from './klex-bot-fixtures';
import type { MascotForm } from './mascot/presets';

export interface Participant {
  name: string;
  avatarSrc?: string;
  mascot?: { color: string; variant: MascotForm };
  role?: string;
}
export interface ScenarioMessage {
  author: Participant;
  time: string;
  text: string;
  status?: string;
}
export interface ConnectorScenario {
  botId: string;
  connectorId: ConnectorId;
  title: string;
  location: string;
  status: string;
  participants: Participant[];
  messages: ScenarioMessage[];
  blocks: { label: string; text: string }[];
  timestamp: string;
  reference: string;
}
const person = (id: string): Participant => {
  const bot = botFixtures.find((item) => item.id === id);
  return bot
    ? {
        name: bot.name,
        role: bot.role,
        mascot: { color: bot.color, variant: bot.variant },
      }
    : { name: id === 'maya' ? 'Maya Chen' : 'Klex coworker', role: 'Teammate' };
};
const message = (
  id: string,
  text: string,
  time = '10:24 AM',
  status?: string,
): ScenarioMessage => ({ author: person(id), text, time, status });

function fallback(botId: string, connectorId: ConnectorId): ConnectorScenario {
  const owner = person(botId);
  const base = {
    botId,
    connectorId,
    participants: [
      owner,
      person(botId === 'kristine' ? 'jonathan' : 'kristine'),
    ],
    timestamp: 'Tuesday, October 20 · Example day',
    reference: 'ACM-142',
  };
  switch (connectorId) {
    case 'slack':
      return {
        ...base,
        title: 'A quick handoff for the team',
        location: '# team-updates',
        status: 'Team conversation',
        blocks: [],
        messages: [
          {
            author: owner,
            time: '10:20 AM',
            text: 'I’ve collected the open questions for the next release. Can we confirm the owner of the final checklist?',
          },
          message(
            'kristine',
            'I’ll own the checklist. Please add any blockers before our afternoon sync.',
          ),
        ],
      };
    case 'github':
      return {
        ...base,
        title: 'Clarify the release checklist',
        location: 'acme / workspace',
        status: 'Open',
        reference: '#248',
        blocks: [
          {
            label: 'Summary',
            text: 'Adds owners and verification steps to the release checklist.',
          },
          {
            label: 'Checks',
            text: 'Documentation checks passed · 1 reviewer requested',
          },
        ],
        messages: [
          {
            author: owner,
            time: '10:20 AM',
            text: 'The checklist is ready for a second look. Please check that each handoff has a clear owner.',
          },
          message(
            'jeff',
            'I’ll walk through the verification steps before we merge.',
          ),
        ],
      };
    case 'google':
      return {
        ...base,
        title: 'Release readiness check-in',
        location: 'Google Calendar',
        status: 'Tentative',
        blocks: [
          { label: 'When', text: 'Tuesday, October 20 · 2:00–2:30 PM' },
          {
            label: 'Agenda',
            text: 'Review open questions, confirm owners, and agree on the next handoff.',
          },
        ],
        messages: [
          {
            author: owner,
            time: '10:20 AM',
            text: 'I’ve prepared the agenda with the remaining questions. The team can review it before the meeting.',
          },
        ],
      };
    case 'linear':
      return {
        ...base,
        title: 'Prepare the release handoff',
        location: 'Acme / Product',
        status: 'Todo',
        blocks: [
          { label: 'Assignee', text: owner.name },
          { label: 'Priority', text: 'Medium · Release readiness' },
          {
            label: 'Acceptance criteria',
            text: 'Every open item has an owner, a verification step, and a target date.',
          },
        ],
        messages: [
          message(
            botId,
            'Created this task from the planning discussion. Ready for the next cycle.',
          ),
        ],
      };
  }
}

type AuthoredScenario = Partial<
  Omit<ConnectorScenario, 'botId' | 'connectorId'>
>;
const authored: Record<string, AuthoredScenario> = {
  'jonathan:slack': {
    title: 'Building saved views',
    location: '# product-engineering',
    messages: [
      message(
        'kristine',
        'Can we let teammates save a filtered project view? Customers keep rebuilding the same filters.',
        '10:18 AM',
      ),
      message(
        'jonathan',
        'Yes. I’ll persist the filters per workspace and add a “Save view” action. Should views be private by default?',
        '10:20 AM',
      ),
      message(
        'kristine',
        'Private first, with an explicit share action. Keep the selected sort order, too.',
        '10:22 AM',
      ),
      message(
        'jonathan',
        'Got it. I’ll include permission tests and send you the first pass today.',
        '10:24 AM',
      ),
    ],
  },
  'jonathan:github': {
    title: 'Add saved project views',
    reference: '#249',
    status: 'Changes requested',
    blocks: [
      {
        label: 'Summary',
        text: 'Persist workspace filters and sort order. New views are private until explicitly shared.',
      },
      {
        label: 'Changes',
        text: '8 files changed · +184 −32 · 24 checks passed',
      },
    ],
    messages: [
      message(
        'jonathan',
        'Opened this PR with the saved-view flow and permission tests.',
        '10:32 AM',
        'Opened pull request',
      ),
      message(
        'jeff',
        'Please reset the saved view when switching workspaces, and add a regression test for an archived project.',
        '10:46 AM',
        'Requested changes',
      ),
      message(
        'jonathan',
        'On it. I’ll push both fixes and request another review.',
        '10:49 AM',
      ),
    ],
  },
  'kristine:slack': {
    title: 'Planning the next product slice',
    location: '# product-planning',
    messages: [
      message(
        'kristine',
        'For this cycle, let’s focus on saved views. The goal is fewer repeated setup steps for project leads.',
        '9:05 AM',
      ),
      message(
        'maya',
        'I can validate the save and share flow with three teammates tomorrow.',
        '9:08 AM',
      ),
      message(
        'jonathan',
        'I’ll split persistence and sharing into separate changes so we can review early.',
        '9:10 AM',
      ),
      message(
        'kristine',
        'Perfect. I’ll write the acceptance criteria and link the task here.',
        '9:12 AM',
      ),
    ],
  },
  'kristine:linear': {
    title: 'Let teammates save a project view',
    reference: 'ACM-143',
    status: 'In progress',
    participants: [person('kristine'), person('jonathan')],
    blocks: [
      { label: 'Assignee', text: 'Jonathan · AI Engineer' },
      { label: 'Priority', text: 'High · Product experience' },
      {
        label: 'Acceptance criteria',
        text: 'Save filters and sort order. Default to private. Only share within the current workspace. Cover workspace switching in tests.',
      },
    ],
    messages: [
      message(
        'kristine',
        'Created from #product-planning and assigned to Jonathan. Maya will validate the first pass tomorrow.',
        '9:16 AM',
        'Created and assigned',
      ),
      message(
        'jonathan',
        'Starting with persistence. I’ll attach the PR once the permission tests pass.',
        '9:22 AM',
      ),
    ],
  },
  'monica:google': {
    title: 'Alex Rivera · technical fit review',
    status: 'Needs team input',
    participants: [person('monica'), person('jonathan')],
    blocks: [
      { label: 'When', text: 'Tuesday, October 20 · 11:00–11:30 AM' },
      {
        label: 'Candidate notes',
        text: 'Alex’s sample résumé lists TypeScript, React, Node.js, and PostgreSQL. Recent work includes a multi-tenant dashboard.',
      },
      {
        label: 'Follow-up',
        text: 'Confirm hands-on testing experience and discuss service boundaries with Jonathan. Résumé evidence alone is not a hiring decision.',
      },
    ],
    messages: [
      message(
        'monica',
        'The listed experience overlaps with our demo stack. Jonathan, could you assess testing depth and API design in the technical conversation?',
        '9:40 AM',
      ),
      message(
        'jonathan',
        'Yes. I’ll prepare a practical discussion around a TypeScript service and its tests.',
        '9:48 AM',
      ),
    ],
  },
  'jeff:github': {
    title: 'Review workspace access guards',
    reference: '#251',
    status: 'Changes requested',
    blocks: [
      {
        label: 'Review scope',
        text: 'Check workspace isolation, expired sessions, and read-only access.',
      },
      {
        label: 'Checks',
        text: '18 checks passed · 1 edge case needs coverage',
      },
    ],
    messages: [
      message(
        'jonathan',
        'Ready for review: shared access guards for project routes.',
        '2:10 PM',
        'Requested review',
      ),
      message(
        'jeff',
        'The main path looks good. An expired session still reaches the cached project view; clear the cache on sign-out and test that path.',
        '2:28 PM',
        'Requested changes',
      ),
      message(
        'jeff',
        'I’ve left the reproduction steps on the PR. Happy to re-review after the fix.',
        '2:30 PM',
      ),
    ],
  },
};

/** Every current pair is materialized; unrecognized pairs get a shell-specific example. */
export const scenarioRegistry: Record<string, ConnectorScenario> =
  Object.fromEntries(
    botFixtures.flatMap((bot) =>
      bot.integrations.map(({ id }) => {
        const connectorId = resolveConnector(id);
        const key = `${bot.id}:${connectorId}`;
        return [key, { ...fallback(bot.id, connectorId), ...authored[key] }];
      }),
    ),
  );
export function getScenario(
  botId: string,
  connector: string | null,
): ConnectorScenario {
  const connectorId = resolveConnector(connector);
  return (
    scenarioRegistry[`${botId}:${connectorId}`] ?? {
      ...fallback(botId, connectorId),
      ...authored[`${botId}:${connectorId}`],
    }
  );
}

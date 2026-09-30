import './coworkers.css';

import { createRoot } from 'react-dom/client';

import { Button } from '@stagewise/ui/src/components/ui/button.tsx';
import { Card, CardContent } from '@stagewise/ui/src/components/ui/card.tsx';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@stagewise/ui/src/components/ui/table.tsx';

import { heroLooks } from '../../bot-looks';
import { Klex } from '../../klex';

export const coworkersMarkup = `
  <section class="new-coworkers" id="coworkers" aria-labelledby="coworkers-title">
    <div class="new-coworkers-mount"></div>
  </section>
`;

const comparisons = [
  {
    topic: 'Accounts',
    sectionTitle: 'Identity management',
    assistant: {
      title: 'Uses your accounts',
      text: 'Works through your accounts and access.',
    },
    coworker: {
      title: 'Have their own accounts',
      text: 'Show up as themselves in Slack, GitHub, and more.',
    },
  },
  {
    topic: 'Teamwork',
    sectionTitle: 'Collaboration',
    assistant: {
      title: 'Works one-on-one with you',
      text: 'You pass on context and coordinate the work.',
    },
    coworker: {
      title: 'Teamwork with each other',
      text: 'They coordinate work and share context with each other.',
    },
  },
  {
    topic: 'Learning',
    sectionTitle: 'Learning',
    assistant: {
      title: 'Learns about you',
      text: 'Basic memory centered on your preferences and tasks.',
    },
    coworker: {
      title: 'Continuously learn and adapt',
      text: 'Learn skills, relationships, and ways of working.',
    },
  },
];

type BotName = keyof typeof heroLooks;
type Kind = 'you' | 'person' | 'company' | 'assistant' | BotName;
type Member = {
  x: number;
  y: number;
  kind: Kind;
  /** The assistant acts through this identity instead of its own. */
  assisted?: boolean;
};
type Scene = {
  members: Member[];
  links?: [number, number][];
  /** One-way handoffs, drawn as a short arrow in the gap between members. */
  arrows?: [number, number][];
};

// Coordinates are in a 160 x 64 stage. Every scene uses the same symbols:
// people, the assistant, and Klex Bots, joined by plain links or one-way arrows.
const scenes: Record<string, { personal: Scene; team: Scene }> = {
  Accounts: {
    personal: { members: [{ x: 80, y: 32, kind: 'you', assisted: true }] },
    team: {
      members: [
        { x: 26, y: 32, kind: 'you' },
        { x: 62, y: 32, kind: 'jonathan' },
        { x: 98, y: 32, kind: 'monica' },
        { x: 134, y: 32, kind: 'kristine' },
      ],
    },
  },
  Teamwork: {
    personal: {
      members: [
        { x: 54, y: 32, kind: 'you' },
        { x: 106, y: 32, kind: 'assistant' },
      ],
      arrows: [[0, 1]],
    },
    team: {
      members: [
        // Optically even rather than geometrically equilateral: the round
        // nodes make a true equilateral triangle read as too tall.
        { x: 80, y: 12.5, kind: 'jonathan' },
        { x: 52, y: 52.5, kind: 'you' },
        { x: 108, y: 52.5, kind: 'kristine' },
      ],
      links: [
        [0, 1],
        [1, 2],
        [2, 0],
      ],
    },
  },
};

// Learning is shown as a thought: who is learning, and what it thinks about.
const thoughts: Record<string, { personal: Kind[]; team: Kind[] }> = {
  Learning: {
    personal: ['assistant', 'you'],
    team: ['monica', 'you', 'company', 'jonathan'],
  },
};

function ThoughtArt({ thinker, about }: { thinker: Kind; about: Kind[] }) {
  return (
    <div className="coworkers-thought">
      <span className="coworkers-node">
        <Glyph kind={thinker} />
      </span>
      <span className="coworkers-thought-tail" />
      <span className="coworkers-thought-bubble">
        {about.map((kind) => (
          <span className="coworkers-node" key={kind}>
            <Glyph kind={kind} small />
          </span>
        ))}
      </span>
    </div>
  );
}

function Glyph({ kind, small }: { kind: Kind; small?: boolean }) {
  if (kind === 'assistant' || kind === 'you') {
    return (
      <span className="coworkers-label">
        {kind === 'assistant' ? 'AI' : 'You'}
      </span>
    );
  }
  if (kind === 'company') {
    return (
      <svg
        viewBox="0 0 20 20"
        fill="none"
        className="coworkers-person"
        aria-hidden="true"
      >
        <path d="M5 16V5.5h7V16M12 8.5h3V16M3.5 16h13M7.5 8h2M7.5 10.5h2M7.5 13h2" />
      </svg>
    );
  }
  if (kind === 'person') {
    return (
      <svg
        viewBox="0 0 20 20"
        fill="none"
        className="coworkers-person"
        aria-hidden="true"
      >
        <circle cx="10" cy="7.75" r="2.75" />
        <path d="M4.75 16a5.25 5.25 0 0 1 10.5 0" />
      </svg>
    );
  }
  return (
    <Klex
      {...heroLooks[kind]}
      size={small ? 15 : 20}
      layout="avatar"
      idle={false}
    />
  );
}

function MiniDiagram({ topic, team }: { topic: string; team: boolean }) {
  const thought = thoughts[topic]?.[team ? 'team' : 'personal'];
  if (thought) {
    const [thinker, ...about] = thought;
    return (
      <div
        className="coworkers-art"
        data-side={team ? 'team' : 'personal'}
        aria-hidden="true"
      >
        <ThoughtArt thinker={thinker} about={about} />
      </div>
    );
  }
  const {
    members,
    links = [],
    arrows = [],
  } = scenes[topic][team ? 'team' : 'personal'];
  return (
    <div
      className="coworkers-art"
      data-side={team ? 'team' : 'personal'}
      aria-hidden="true"
    >
      <div className="coworkers-stage">
        <svg viewBox="0 0 160 64" fill="none" aria-hidden="true">
          {links.map(([from, to]) => (
            <line
              key={`${from}-${to}`}
              vectorEffect="non-scaling-stroke"
              x1={members[from].x}
              y1={members[from].y}
              x2={members[to].x}
              y2={members[to].y}
            />
          ))}
          {arrows.map(([from, to]) => {
            const start = members[from].x + 19;
            const end = members[to].x - 19;
            const y = members[from].y;
            return (
              <path
                key={`${from}-${to}`}
                className="coworkers-arrow"
                vectorEffect="non-scaling-stroke"
                d={`M${start} ${y}H${end}M${end - 4} ${y - 4}L${end} ${y}L${end - 4} ${y + 4}`}
              />
            );
          })}
        </svg>
        {members.map(({ x, y, kind, assisted }) => (
          <span
            className="coworkers-node coworkers-member"
            data-kind={kind}
            style={{ left: `${(x / 160) * 100}%`, top: `${(y / 64) * 100}%` }}
            key={`${x}-${y}`}
          >
            <Glyph kind={kind} />
            {assisted && (
              <span className="coworkers-badge">
                <Glyph kind="assistant" />
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function Coworkers() {
  return (
    <>
      <h2 id="coworkers-title" className="coworkers-title">
        <span>
          Personal <span className="coworkers-nowrap">AI-Assistants</span> don't
          work for your business.
        </span>{' '}
        <span>Klex Bots are digital coworkers that do.</span>
      </h2>
      <Card className="coworkers-card ring-0">
        <CardContent className="px-0">
          <Table className="coworkers-comparison">
            <TableCaption className="sr-only">
              Personal AI Assistant compared with Klex Bots
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">
                  <div className="coworkers-product" aria-hidden="true">
                    <span className="coworkers-assistant-symbol">AI</span>
                  </div>
                  <span className="coworkers-column-title" data-font="plain">
                    Personal AI Assistant
                  </span>
                  <p>Built around you.</p>
                </TableHead>
                <TableHead scope="col">
                  <div className="coworkers-product" aria-hidden="true">
                    {(['monica', 'jonathan', 'kristine'] as const).map(
                      (bot) => (
                        <Klex
                          key={bot}
                          {...heroLooks[bot]}
                          size={64}
                          layout="avatar"
                          idle={false}
                        />
                      ),
                    )}
                  </div>
                  <span className="coworkers-column-title">Klex Bots</span>
                  <p>Built into your team.</p>
                  <Button
                    size="lg"
                    className="coworkers-cta rounded-full px-4"
                    nativeButton={false}
                    role="link"
                    render={<a href="https://cloud.klex.bot" />}
                  >
                    Create a Klex Bot
                  </Button>
                </TableHead>
              </TableRow>
            </TableHeader>
            {comparisons.map(({ topic, sectionTitle, assistant, coworker }) => (
              <TableBody
                key={topic}
                aria-labelledby={`coworkers-${topic.toLowerCase()}-title`}
              >
                <TableRow className="coworkers-topic-row">
                  <TableHead colSpan={2} scope="rowgroup">
                    <h3
                      id={`coworkers-${topic.toLowerCase()}-title`}
                      className="coworkers-topic-title"
                    >
                      {sectionTitle}
                    </h3>
                  </TableHead>
                </TableRow>
                <TableRow>
                  {[assistant, coworker].map(({ title, text }, index) => (
                    <TableCell key={title}>
                      <MiniDiagram topic={topic} team={index === 1} />
                      <strong className="coworkers-cell-title">{title}</strong>
                      <p>{text}</p>
                    </TableCell>
                  ))}
                </TableRow>
              </TableBody>
            ))}
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

export function mountCoworkers() {
  const host = document.querySelector('.new-coworkers-mount');
  if (!host) throw new Error('The coworkers section is missing.');
  const root = createRoot(host);
  root.render(<Coworkers />);
  return () => root.unmount();
}

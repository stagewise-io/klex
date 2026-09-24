import './connector-shells.css';

import type { ComponentType, ReactNode } from 'react';

import {
  type ConnectorId,
  connectorRegistry,
  resolveConnector,
} from './connector-registry';
import {
  type ConnectorScenario,
  getScenario,
  type Participant,
} from './connector-scenarios';
import { type KlexBotSelection, KlexCardMascot } from './klex-bot-card';

type ShellProps = { scenario: ConnectorScenario };
function Avatar({ person }: { person: Participant }) {
  return (
    <span className="workflow-avatar" role="img" aria-label={person.name}>
      {person.avatarSrc ? (
        <img src={person.avatarSrc} alt="" />
      ) : person.mascot ? (
        <KlexCardMascot {...person.mascot} />
      ) : (
        <span>
          {person.name
            .split(' ')
            .map((part) => part[0])
            .join('')}
        </span>
      )}
    </span>
  );
}
function Messages({ scenario }: ShellProps) {
  return (
    <div className="workflow-messages">
      {scenario.messages.map((message) => (
        <article
          className="workflow-message"
          key={`${message.author.name}-${message.time}-${message.text}`}
        >
          <Avatar person={message.author} />
          <div>
            <div className="workflow-author">
              <strong>{message.author.name}</strong>
              {message.author.mascot && <span className="bot-label">BOT</span>}
              <time>{message.time}</time>
            </div>
            {message.status && (
              <small className="workflow-review-status">{message.status}</small>
            )}
            <p>{message.text}</p>
          </div>
        </article>
      ))}
    </div>
  );
}
function Blocks({ scenario }: ShellProps) {
  return (
    <dl className="workflow-blocks">
      {scenario.blocks.map((block) => (
        <div key={block.label}>
          <dt>{block.label}</dt>
          <dd>{block.text}</dd>
        </div>
      ))}
    </dl>
  );
}
function ShellFrame({
  scenario,
  children,
}: ShellProps & { children: ReactNode }) {
  const connector = connectorRegistry[scenario.connectorId];
  return (
    <>
      <header className="workflow-toolbar">
        <img src={connector.logoSrc} width="24" height="24" alt="" />
        <strong>{scenario.location}</strong>
        <span>Demo</span>
      </header>
      {children}
    </>
  );
}
function Status({ children }: { children: ReactNode }) {
  return <span className="workflow-status">{children}</span>;
}

export function SlackShell({ scenario }: ShellProps) {
  return (
    <ShellFrame scenario={scenario}>
      <div className="workflow-slack-layout">
        <aside className="slack-sidebar">
          <strong>
            Acme
            <br />
            workspace
          </strong>
          <p>Channels</p>
          <span># general</span>
          <span className="channel-selected">{scenario.location}</span>
          <span># team-updates</span>
          <p>Direct messages</p>
          {scenario.participants.map((person) => (
            <span key={person.name}>{person.name}</span>
          ))}
        </aside>
        <div className="workflow-conversation">
          <div className="date-divider">Today · {scenario.title}</div>
          <Messages scenario={scenario} />
          <div className="workflow-composer">
            Message {scenario.location}
            <small>Illustrative conversation</small>
          </div>
        </div>
      </div>
    </ShellFrame>
  );
}
export function GitHubShell({ scenario }: ShellProps) {
  return (
    <ShellFrame scenario={scenario}>
      <div className="workflow-tabs">
        <span>Code</span>
        <strong>Pull requests</strong>
        <span>Actions</span>
      </div>
      <div className="workflow-content">
        <h3>
          {scenario.title}{' '}
          <span className="workflow-muted">{scenario.reference}</span>
        </h3>
        <Status>{scenario.status}</Status>
        <p className="workflow-muted">
          {scenario.participants[0]?.name} · <code>main</code> ·{' '}
          {scenario.timestamp}
        </p>
        <Blocks scenario={scenario} />
        <div className="workflow-thread">
          <Messages scenario={scenario} />
        </div>
      </div>
    </ShellFrame>
  );
}
export function GoogleWorkspaceShell({ scenario }: ShellProps) {
  return (
    <ShellFrame scenario={scenario}>
      <div className="workflow-calendar-date">
        <img
          src="/connectors/googlecalendar.svg"
          alt=""
          width="28"
          height="28"
        />
        <strong>{scenario.timestamp}</strong>
      </div>
      <div className="workflow-content">
        <h3>{scenario.title}</h3>
        <Status>{scenario.status}</Status>
        <Blocks scenario={scenario} />
        <div className="workflow-guests">
          <span>Guests</span>
          {scenario.participants.map((person) => (
            <span key={person.name}>
              <Avatar person={person} />
              {person.name}
            </span>
          ))}
        </div>
        <div className="workflow-thread">
          <Messages scenario={scenario} />
        </div>
      </div>
    </ShellFrame>
  );
}
export function LinearShell({ scenario }: ShellProps) {
  return (
    <ShellFrame scenario={scenario}>
      <div className="workflow-tabs">
        <span>Product experience</span>
        <strong>{scenario.reference}</strong>
      </div>
      <div className="workflow-content">
        <h3>{scenario.title}</h3>
        <Status>{scenario.status}</Status>
        <Blocks scenario={scenario} />
        <div className="workflow-thread">
          <h4>Activity</h4>
          <Messages scenario={scenario} />
        </div>
      </div>
    </ShellFrame>
  );
}
export const connectorShells: Record<ConnectorId, ComponentType<ShellProps>> = {
  slack: SlackShell,
  github: GitHubShell,
  google: GoogleWorkspaceShell,
  linear: LinearShell,
};

export function ConnectorPanels({
  selection,
}: {
  selection: KlexBotSelection;
}) {
  const selected = resolveConnector(selection.integrationId);
  const scenario = getScenario(selection.botId, selected);
  return (
    <section
      className="connector-demo workflow-panels"
      aria-label="Illustrative connector interfaces"
    >
      {(Object.keys(connectorShells) as ConnectorId[]).map((id) => {
        const Shell = connectorShells[id];
        const data = getScenario(selection.botId, id);
        const active = selected === id;
        return (
          <section
            key={id}
            className={`connector-panel workflow-panel workflow-${id}`}
            data-scenario={`${selection.botId}:${id}`}
            aria-current={active ? 'true' : undefined}
            aria-hidden={!active}
            inert={!active}
            aria-label={`${selection.botId} in ${connectorRegistry[id].name}: ${data.title}`}
          >
            <div
              key={`${selection.botId}:${id}`}
              className="workflow-panel-content"
            >
              <Shell scenario={data} />
            </div>
          </section>
        );
      })}
      <p className="klex-bot-roster-status" role="status">
        {selection.botId} in {connectorRegistry[selected].name}:{' '}
        {scenario.title}. Illustrative demo.
      </p>
    </section>
  );
}

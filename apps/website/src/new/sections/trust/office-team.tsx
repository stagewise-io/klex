import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';

import {
  Popover,
  PopoverTrigger,
} from '@stagewise/ui/src/components/ui/popover.tsx';

import { Klex, type KlexHandle } from '../../klex';
import { botProfileApps, ProfileCard } from '../../profile-card';
import { project } from './office';
import { type OfficeMember, officeMembers } from './office-members';

type OfficeBotSlot = {
  member: Extract<OfficeMember, { kind: 'bot' }>;
  host: SVGGElement;
};

function WorkingOfficeBot({
  member,
  active,
}: {
  member: OfficeBotSlot['member'];
  active: boolean;
}) {
  const handle = useRef<KlexHandle>(null);
  useEffect(() => {
    if (active) handle.current?.resume();
    else handle.current?.pause();
  }, [active]);
  return (
    <Klex
      ref={handle}
      color={member.color}
      shape={member.shape}
      size={160}
      layout="svg"
      initialPosition={{ x: 0, y: -23 }}
      movementMode={member.movementMode}
      className="office-scene-bot"
      activity="working"
    />
  );
}

function OfficeTeam({
  stage,
  bots,
}: {
  stage: HTMLElement;
  bots: OfficeBotSlot[];
}) {
  const [visibility, setVisibility] = useState(0);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisibility(entry.intersectionRatio);
        if (!entry.isIntersecting) setActive(null);
      },
      { threshold: [0, 0.55] },
    );
    observer.observe(stage);
    const onVisibility = () => {
      setPageVisible(!document.hidden);
      if (document.hidden) setActive(null);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [stage]);

  return (
    <>
      {bots.map(({ member, host }) =>
        createPortal(
          <WorkingOfficeBot
            member={member}
            active={visibility > 0 && pageVisible}
          />,
          host,
          member.id,
        ),
      )}
      <div className="office-member-triggers">
        {officeMembers
          .filter((member) => member.kind === 'bot')
          .map((member, index) => {
            const point = project(member.position);
            const scale = 1240 / point.depth;
            const memberHeight =
              1.35 + (member.movementMode === 'fly' ? 0.64 : 0);
            const top = point.y - scale * memberHeight;
            return (
              <Popover
                key={member.id}
                open={active === index && visibility > 0 && pageVisible}
                onOpenChange={(open) =>
                  setActive((current) =>
                    open ? index : current === index ? null : current,
                  )
                }
              >
                <PopoverTrigger
                  className="office-member-trigger"
                  openOnHover
                  delay={100}
                  closeDelay={180}
                  style={
                    {
                      '--member-x': `${((point.x + 100) / 1600) * 100}%`,
                      '--member-y': `${((top - 100) / 650) * 100}%`,
                      '--member-width': `${((scale * 1.15) / 1600) * 100}%`,
                      '--member-height': `${((scale * memberHeight) / 650) * 100}%`,
                    } as CSSProperties
                  }
                  aria-label={`${member.name}, ${member.role}. Show details`}
                  onFocus={(event) => {
                    if (event.currentTarget.matches(':focus-visible'))
                      setActive(index);
                  }}
                  onBlur={() =>
                    setActive((current) => (current === index ? null : current))
                  }
                />
                <ProfileCard
                  className="new-bot-profile new-member-hover-card office-member-profile w-64 max-w-[calc(100vw-1.5rem)] gap-3 overflow-x-hidden overflow-y-auto rounded-[10px] p-4 ring-0"
                  name={member.name}
                  role={member.role}
                  work={member.work}
                  apps={botProfileApps[member.id]}
                  side="top"
                  initialFocus={false}
                  finalFocus={true}
                />
              </Popover>
            );
          })}
      </div>
    </>
  );
}

export function mountOffice() {
  const host = document.querySelector<HTMLElement>('.office-team-mount');
  const stage = document.querySelector<HTMLElement>('.office-stage');
  if (!host || !stage) return () => {};
  const bots = officeMembers.flatMap((member) => {
    if (member.kind !== 'bot') return [];
    const figure = stage.querySelector<SVGGElement>(
      `[data-office-bot="${member.id}"]`,
    );
    return figure ? [{ member, host: figure }] : [];
  });
  const root = createRoot(host);
  root.render(<OfficeTeam stage={stage} bots={bots} />);
  return () => root.unmount();
}

import { Klex } from '@klex/mascot';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { Popover, PopoverTrigger } from '@stagewise/ui';

import { botProfileApps, ProfileCard } from '../../profile-card';
import { project } from './office-figures';
import { type OfficeMember, officeMembers } from './office-members';

type OfficeBotSlot = {
  member: Extract<OfficeMember, { kind: 'bot' }>;
  host: SVGGElement;
};

function OfficeTeam({
  stage,
  bots,
}: {
  stage: HTMLElement;
  bots: OfficeBotSlot[];
}) {
  const [active, setActive] = useState<number | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Not every browser reports the pointer type on click, so keep it from
  // pointerdown.
  const pointer = useRef('');

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }, []);
  const enterProfile = (index: number, pointerType: string) => {
    if (pointerType !== 'mouse') return;
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setActive(index);
    }, 100);
  };
  const leaveProfile = (index: number, pointerType: string) => {
    if (pointerType !== 'mouse') return;
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setActive((current) => (current === index ? null : current));
    }, 180);
  };

  // Bots pause themselves offscreen; close any profile they leave open.
  useEffect(() => {
    const close = () => {
      clearHoverTimer();
      setActive(null);
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) close();
    });
    observer.observe(stage);
    const onVisibility = () => {
      if (document.hidden) close();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearHoverTimer();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [stage, clearHoverTimer]);

  return (
    <>
      {bots.map(({ member, host }) =>
        createPortal(
          <Klex
            color={member.color}
            shape={member.shape}
            size={160}
            layout="svg"
            initialPosition={{ x: 0, y: -23 }}
            movementMode={member.movementMode}
            className="office-scene-bot"
            activity="working"
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
                open={active === index}
                onOpenChange={(open, { reason, event }) => {
                  // Mouse users open profiles by hovering; clicks don't toggle them.
                  if (
                    reason === 'trigger-press' &&
                    (event as MouseEvent).detail > 0 &&
                    pointer.current === 'mouse'
                  )
                    return;
                  clearHoverTimer();
                  setActive((current) =>
                    open ? index : current === index ? null : current,
                  );
                }}
              >
                <PopoverTrigger
                  className="office-member-trigger"
                  onPointerDown={(event) => {
                    pointer.current = event.pointerType;
                  }}
                  onPointerEnter={(event) =>
                    enterProfile(index, event.pointerType)
                  }
                  onPointerLeave={(event) =>
                    leaveProfile(index, event.pointerType)
                  }
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
                    if (event.currentTarget.matches(':focus-visible')) {
                      clearHoverTimer();
                      setActive(index);
                    }
                  }}
                  onBlur={() => {
                    clearHoverTimer();
                    setActive((current) =>
                      current === index ? null : current,
                    );
                  }}
                />
                <ProfileCard
                  className="new-bot-profile new-member-hover-card office-member-profile w-64 max-w-[calc(100vw-1.5rem)] gap-3 overflow-x-hidden overflow-y-auto rounded-[10px] p-4 ring-0"
                  name={member.name}
                  role={member.role}
                  work={member.work}
                  apps={botProfileApps[member.id]}
                  side="top"
                  onPointerEnter={clearHoverTimer}
                  onPointerLeave={(event) =>
                    leaveProfile(index, event.pointerType)
                  }
                  initialFocus={false}
                  finalFocus={false}
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

import { type BotSpot, workflowActor } from '../workflow/actors';
import { STEP_ENTER, STEP_LEAVE } from '../workflow/stage';

type MonicaPhase = 'hidden' | 'replying' | 'working' | 'done';

export function mountSlackMonica(host: HTMLElement) {
  let phase: MonicaPhase = 'hidden';
  const slide = host.closest('.new-workflow-slide');
  if (!slide) throw new Error('Slack Monica must live in a workflow slide.');
  const home: BotSpot = () => {
    const box = host.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.bottom, speech: 'right' };
  };
  const enter = () => {
    if (phase !== 'hidden') workflowActor(host, 'monica')?.place(home);
  };
  const leave = () => workflowActor(host, 'monica')?.rest();
  slide.addEventListener(STEP_ENTER, enter);
  slide.addEventListener(STEP_LEAVE, leave);
  return {
    setPhase(next: MonicaPhase) {
      phase = next;
      if (slide.getAttribute('aria-hidden') === 'true') return;
      const monica = workflowActor(host, 'monica');
      if (phase === 'hidden') {
        monica?.hide();
        return;
      }
      if (!monica?.visible()) {
        if (phase === 'replying') monica?.pop(home);
        else monica?.place(home);
      }
      const writing = phase === 'replying' || phase === 'working';
      monica?.setActivity(writing ? 'working' : 'idle');
      monica?.say(phase === 'replying' ? 'Writing…' : null);
      if (phase === 'done') monica?.emote('happy-nod');
    },
    dispose: () => {
      slide.removeEventListener(STEP_ENTER, enter);
      slide.removeEventListener(STEP_LEAVE, leave);
    },
  };
}

import './speech.css';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useLayoutEffect, useRef } from 'react';

import { Bubble, BubbleContent } from '@stagewise/ui';

import { popTransition } from './transitions';

export type KlexSpeechValue = { text: string; waiting?: boolean };

export function KlexSpeech({ speech }: { speech: KlexSpeechValue | null }) {
  return (
    <AnimatePresence mode="wait">
      {speech && <SpeechBubble key={speech.text} speech={speech} />}
    </AnimatePresence>
  );
}

function SpeechBubble({ speech }: { speech: KlexSpeechValue }) {
  const reducedMotion = useReducedMotion();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Speech changes resize the rendered text and waiting dots measured below.
  useLayoutEffect(() => {
    const fitText = () => {
      const bubble = bubbleRef.current;
      const label = textRef.current;
      if (!bubble || !label) return;
      bubble.style.width = '';
      const content = label.parentElement;
      if (!content) return;
      const style = getComputedStyle(content);
      // Measure outside the actor so jumping, scaling, and rotation cannot
      // change the text's layout width.
      const measurement = content.cloneNode(true) as HTMLElement;
      Object.assign(measurement.style, {
        position: 'fixed',
        visibility: 'hidden',
        left: '0',
        top: '0',
        width: `${content.offsetWidth}px`,
        font: style.font,
        padding: style.padding,
        border: style.border,
        boxSizing: style.boxSizing,
        whiteSpace: style.whiteSpace,
      });
      document.body.append(measurement);
      const lines = [...(measurement.lastElementChild?.getClientRects() ?? [])];
      measurement.remove();
      if (!lines.length) return;
      const padding =
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight) +
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.borderRightWidth);
      bubble.style.width = `${Math.ceil(Math.max(...lines.map((line) => line.width)) + padding)}px`;
    };
    fitText();
    window.addEventListener('resize', fitText);
    return () => window.removeEventListener('resize', fitText);
  }, [speech]);

  return (
    <motion.div
      ref={bubbleRef}
      data-klex-speech=""
      className="pointer-events-none absolute bottom-1/2 left-[calc(100%+0.5rem)] z-10 w-max max-w-[min(11rem,calc(50vw-5rem))] origin-bottom-left text-left"
      initial={{ opacity: 0, scale: reducedMotion ? 1 : 0 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{
        opacity: 0,
        scale: reducedMotion ? 1 : 0,
        transition: { duration: reducedMotion ? 0 : 0.12, ease: 'easeIn' },
      }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : {
              scale: popTransition,
              opacity: { duration: 0.12 },
            }
      }
    >
      <Bubble
        variant="secondary"
        className="klex-speech-float w-full max-w-none"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 32 24"
          className="absolute -left-2 bottom-0 h-5 w-6 fill-secondary"
        >
          <path d="M18 0C18 10 11 19 1 23C14 24 26 18 32 10Z" />
        </svg>
        <BubbleContent className="relative w-full rounded-2xl text-balance text-xs">
          <span
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {speech.text}
            {speech.waiting ? '…' : ''}
          </span>
          <span ref={textRef} aria-hidden="true">
            {speech.text}
            {speech.waiting && (
              <span className="ml-1 inline-flex">
                {[0, 1, 2].map((dot) => (
                  <motion.span
                    key={dot}
                    animate={{
                      opacity: reducedMotion ? 1 : [0.25, 1, 0.25],
                    }}
                    transition={{
                      duration: 1.2,
                      delay: dot * 0.18,
                      repeat: reducedMotion ? 0 : Infinity,
                    }}
                  >
                    .
                  </motion.span>
                ))}
              </span>
            )}
          </span>
        </BubbleContent>
      </Bubble>
    </motion.div>
  );
}

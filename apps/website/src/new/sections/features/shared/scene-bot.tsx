import { useEffect, useRef } from 'react';

import { heroLooks } from '../../../bot-looks';
import {
  type EmoteId,
  Klex,
  type KlexActivity,
  type KlexHandle,
} from '../../../klex';
import { BODY_SHAPES } from '../../../klex/presets';
import type { SceneProps } from './feature-card';

export const bentoBotLook = {
  color: '#2559fe',
  shape: BODY_SHAPES[0],
  movementMode: 'fly',
} as const;

export function SceneBot({
  active,
  bot,
  beat = 0,
  reaction,
  speech,
  activity = 'idle',
  size = 66,
}: SceneProps & {
  bot?: 'kristine' | 'jonathan' | 'monica' | 'jeff';
  beat?: number;
  reaction?: EmoteId;
  speech?: string | null;
  activity?: KlexActivity;
  size?: number;
}) {
  const handle = useRef<KlexHandle>(null);
  useEffect(() => {
    handle.current?.say(speech ?? null);
  }, [speech]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each new scene beat intentionally replays the emote, even when the reaction is unchanged.
  useEffect(() => {
    if (!active) {
      handle.current?.pause();
      return;
    }
    handle.current?.resume();
    if (reaction) handle.current?.emote(reaction);
  }, [active, beat, reaction]);
  return (
    <Klex
      ref={handle}
      {...(bot ? heroLooks[bot] : bentoBotLook)}
      size={size}
      layout="avatar"
      activity={activity}
    />
  );
}

import {
  type EmoteId,
  Klex,
  type KlexActivity,
  type KlexHandle,
} from '@klex/mascot';
import { useEffect, useRef } from 'react';

import { heroLooks, klexLook } from '../../../bot-looks';
import type { SceneProps } from './feature-card';

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
      {...(bot ? heroLooks[bot] : klexLook)}
      size={size}
      layout="avatar"
      activity={activity}
    />
  );
}

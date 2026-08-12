import { type output, type ZodType, z } from 'zod/v4';

import { LiveKitRoomTransportDescriptorSchema } from '../generated/schema.js';
import type {
  AcceptRealtimeMediaSessionResult,
  RealtimeMediaTransportDescriptor,
} from '../spec.types.js';

const knownTransportSchemas = {
  'livekit-room': LiveKitRoomTransportDescriptorSchema,
} as const satisfies Record<string, ZodType<RealtimeMediaTransportDescriptor>>;

type KnownTransportSchemas = typeof knownTransportSchemas;

export type KnownRealtimeMediaTransportProfile = keyof KnownTransportSchemas;

export type KnownDecodedRealtimeMediaTransport = {
  [Profile in KnownRealtimeMediaTransportProfile]: {
    kind: Profile;
    descriptor: output<KnownTransportSchemas[Profile]> &
      Record<string, unknown>;
  };
}[KnownRealtimeMediaTransportProfile];

export interface UnknownDecodedRealtimeMediaTransport {
  kind: 'unknown';
  descriptor: RealtimeMediaTransportDescriptor;
}

export type DecodedRealtimeMediaTransport =
  | KnownDecodedRealtimeMediaTransport
  | UnknownDecodedRealtimeMediaTransport;

export type RealtimeMediaClientAcceptResult = Omit<
  AcceptRealtimeMediaSessionResult,
  'transport'
> & {
  transport: DecodedRealtimeMediaTransport;
};

export function decodeRealtimeMediaAcceptResult(
  result: AcceptRealtimeMediaSessionResult,
): RealtimeMediaClientAcceptResult {
  const { transport } = result;
  if (!isKnownTransportProfile(transport.profile)) {
    return { ...result, transport: { kind: 'unknown', descriptor: transport } };
  }

  return {
    ...result,
    transport: decodeKnownTransport(transport.profile, transport),
  };
}

function isKnownTransportProfile(
  profile: string,
): profile is KnownRealtimeMediaTransportProfile {
  return Object.hasOwn(knownTransportSchemas, profile);
}

function decodeKnownTransport<
  Profile extends KnownRealtimeMediaTransportProfile,
>(
  profile: Profile,
  descriptor: RealtimeMediaTransportDescriptor,
): Extract<KnownDecodedRealtimeMediaTransport, { kind: Profile }> {
  const parsed = z.parse(knownTransportSchemas[profile], descriptor);
  return {
    kind: profile,
    descriptor: { ...descriptor, ...parsed },
  } as unknown as Extract<
    KnownDecodedRealtimeMediaTransport,
    { kind: Profile }
  >;
}

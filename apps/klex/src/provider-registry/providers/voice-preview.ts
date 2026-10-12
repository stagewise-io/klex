import WebSocket from 'ws';

import { geminiLiveWebSocketUrl } from '@/config';

import type {
  ProviderInstance,
  ProviderOperationResult,
  ProviderVoicePreview,
  ProviderVoicePreviewContext,
} from '../provider-registry';
import {
  available,
  customHeaders,
  isRecord,
  setting,
  unavailable,
} from './shared';
import {
  isGeminiVoiceId,
  isGeminiVoiceModel,
  openAiVoiceProfile,
} from './voice-catalogs';
import {
  validVoiceIntroduction,
  voicePreviewInstructions,
} from './voice-preview-context';

const RATE = 24_000;
const MAX_PCM_BYTES = RATE * 2 * 12;
const MAX_MESSAGE_BYTES = 1_048_576;

type Connector = (url: string, options: WebSocket.ClientOptions) => WebSocket;

/** Isolated, tool-free audition. The registry validates catalog membership first. */
export async function generateVoicePreview(
  instance: ProviderInstance,
  modelId: string,
  voiceId: string,
  signal: AbortSignal,
  context: ProviderVoicePreviewContext = { name: 'Agent', soul: null },
  connect: Connector = (url, options) => new WebSocket(url, options),
): Promise<ProviderOperationResult<ProviderVoicePreview>> {
  const gemini = instance.type === 'google-gemini';
  const supported = gemini
    ? isGeminiVoiceModel(modelId) && isGeminiVoiceId(voiceId)
    : openAiVoiceProfile(modelId) !== undefined &&
      /^[a-z][a-z0-9_-]{0,63}$/.test(voiceId) &&
      !voiceId.startsWith('voice_');
  if (!supported)
    return unavailable(
      'invalid_configuration',
      'Voice is not supported by this model',
    );
  const key = setting(instance, 'apiKey');
  if (!key)
    return unavailable(
      'authentication_required',
      'Configure a provider API key',
    );
  if (signal.aborted)
    return unavailable('preview_failed', 'Voice preview cancelled');
  const live = !gemini && modelId.startsWith('gpt-live-');
  const instructions = voicePreviewInstructions(context, voiceId);
  let introduction: string | undefined;
  if (live) {
    if (!context.generateIntroduction)
      return unavailable(
        'invalid_configuration',
        'Select a chat model to generate a Live voice introduction',
      );
    try {
      introduction = (
        await context.generateIntroduction(instructions, signal)
      ).trim();
      if (signal.aborted)
        return unavailable('preview_failed', 'Voice preview cancelled');
      if (!validVoiceIntroduction(introduction))
        return unavailable(
          'preview_failed',
          'Voice introduction was empty or exceeded the 20-word limit',
        );
    } catch {
      return unavailable(
        'preview_failed',
        'Could not generate the voice introduction',
      );
    }
  }
  const speechInstructions = live
    ? 'Speak the supplied commentary as a short voice introduction. Do not add any other speech.'
    : instructions;
  let socket: WebSocket;
  try {
    const base =
      setting(instance, 'baseUrl') ??
      (gemini
        ? 'https://generativelanguage.googleapis.com'
        : 'https://api.openai.com/v1');
    const endpoint = new URL(base);
    if (
      !['https:', 'http:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    )
      return unavailable('invalid_configuration', 'Invalid preview endpoint');
    endpoint.hash = '';
    const url = gemini
      ? new URL(geminiLiveWebSocketUrl(endpoint.toString(), key))
      : endpoint;
    if (!gemini) {
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.search = '';
      url.pathname = `${url.pathname.replace(/\/$/, '')}/${live ? 'live/sessions' : 'realtime'}`;
      if (!live) url.searchParams.set('model', modelId);
    }
    socket = connect(url.toString(), {
      headers: {
        ...customHeaders(instance),
        ...(!gemini && { Authorization: `Bearer ${key}` }),
      },
      maxPayload: MAX_MESSAGE_BYTES,
      handshakeTimeout: 10_000,
      followRedirects: false,
    });
  } catch {
    return unavailable(
      'invalid_configuration',
      'Could not open voice preview connection',
    );
  }
  return new Promise((resolve) => {
    let settled = false;
    let ready = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let silence: ReturnType<typeof setInterval> | undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(
      () => finish(unavailable('preview_failed', 'Voice preview timed out')),
      30_000,
    );
    const finish = (result: ProviderOperationResult<ProviderVoicePreview>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(quiet);
      clearInterval(silence);
      signal.removeEventListener('abort', cancel);
      socket.removeAllListeners();
      // Termination during a handshake can emit an asynchronous error.
      socket.on('error', () => undefined);
      socket.terminate();
      resolve(result);
    };
    const fail = (message = 'Provider could not generate a voice preview') =>
      finish(unavailable('preview_failed', message));
    const complete = () => {
      if (!bytes) {
        fail();
        return;
      }
      finish(
        available({
          audio: pcmWav(Buffer.concat(chunks)),
          mimeType: 'audio/wav',
          sourceModelId: modelId,
          mode: 'live',
        }),
      );
    };
    const send = (value: unknown) => socket.send(JSON.stringify(value));
    const append = (value: unknown) => {
      if (
        !ready ||
        typeof value !== 'string' ||
        !value.length ||
        value.length > MAX_MESSAGE_BYTES ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          value,
        )
      )
        throw new Error('Invalid audio');
      let pcm = Buffer.from(value, 'base64');
      if (!pcm.length || pcm.length % 2)
        throw new Error('Invalid audio length');
      if (pcm.length > MAX_PCM_BYTES) throw new Error('Audio limit exceeded');
      // Live emits clocked PCM even while silent. Wait for speech, then finish
      // after 750 ms without voiced audio, not after a gap in socket messages.
      if (live) {
        let energy = 0;
        for (let offset = 0; offset < pcm.length; offset += 2) {
          const sample = pcm.readInt16LE(offset);
          energy += sample * sample;
        }
        const voiced = energy / (pcm.length / 2) > 100 * 100;
        if (!bytes && !voiced) return;
        if (voiced) {
          clearTimeout(quiet);
          quiet = setTimeout(complete, 750);
        } else {
          // Keep the silence timer running even when the WAV buffer is full.
          // Only silence may be truncated; subsequent speech still hits the cap.
          pcm = pcm.subarray(0, MAX_PCM_BYTES - bytes);
          if (!pcm.length) return;
        }
      }
      if (bytes + pcm.length > MAX_PCM_BYTES)
        throw new Error('Audio limit exceeded');
      bytes += pcm.length;
      chunks.push(pcm);
    };
    const cancel = () =>
      finish(unavailable('preview_failed', 'Voice preview cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    socket.on('open', () => {
      try {
        if (gemini)
          send({
            setup: {
              model: modelId.startsWith('models/')
                ? modelId
                : `models/${modelId}`,
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } },
                },
              },
              systemInstruction: { parts: [{ text: speechInstructions }] },
            },
          });
        else if (live)
          send({
            type: 'session.start',
            session: {
              model: modelId,
              store: false,
              instructions: speechInstructions,
              input: [],
              delegation: { type: 'client' },
              audio: {
                format: { type: 'audio/pcm', rate: RATE },
                output: { voice: voiceId },
              },
            },
          });
        else
          send({
            type: 'session.update',
            session: {
              type: 'realtime',
              instructions: speechInstructions,
              tools: [],
              audio: {
                input: { turn_detection: null },
                output: {
                  format: { type: 'audio/pcm', rate: RATE },
                  voice: voiceId,
                },
              },
            },
          });
      } catch {
        fail();
      }
    });
    socket.on('message', (raw) => {
      try {
        if (settled) return;
        if (raw.toString().length > MAX_MESSAGE_BYTES)
          throw new Error('Oversized message');
        const event: unknown = JSON.parse(raw.toString());
        if (!isRecord(event)) throw new Error('Malformed message');
        if (event.error || event.type === 'error') {
          const quota =
            isRecord(event.error) &&
            ['rate_limit_exceeded', 'insufficient_quota'].includes(
              String(event.error.code),
            );
          finish(
            unavailable(
              quota ? 'rate_limited' : 'preview_failed',
              providerErrorSummary(event.error),
            ),
          );
          return;
        }
        if (gemini) {
          if (event.setupComplete !== undefined && !ready) {
            ready = true;
            send({
              clientContent: {
                turns: [
                  { role: 'user', parts: [{ text: speechInstructions }] },
                ],
                turnComplete: true,
              },
            });
          }
          if (event.toolCall) throw new Error('Unexpected tools');
          if (isRecord(event.serverContent)) {
            const content = event.serverContent;
            if (
              isRecord(content.modelTurn) &&
              Array.isArray(content.modelTurn.parts)
            )
              for (const part of content.modelTurn.parts) {
                if (!isRecord(part) || !isRecord(part.inlineData)) continue;
                if (part.inlineData.mimeType !== 'audio/pcm;rate=24000')
                  throw new Error('Unexpected encoding');
                append(part.inlineData.data);
              }
            if (content.interrupted) throw new Error('Interrupted sample');
            if (content.turnComplete) complete();
          }
        } else if (live) {
          if (event.type === 'session.started' && !ready) {
            ready = true;
            send({
              type: 'session.commentary.append',
              event_id: 'preview_commentary',
              delegation_id: null,
              content: introduction,
            });
            const clock = () => {
              try {
                send({
                  type: 'session.input_audio.append',
                  audio: Buffer.alloc(960).toString('base64'),
                });
              } catch {
                fail();
              }
            };
            clock();
            silence = setInterval(clock, 20);
          }
          if (
            event.type === 'session.delegation.created' ||
            (typeof event.type === 'string' &&
              event.type.startsWith('session.response.'))
          )
            throw new Error('Unexpected delegation');
          if (event.type === 'session.output_audio.delta') append(event.delta);
          if (event.type === 'session.closed') {
            fail();
            return;
          }
        } else {
          if (event.type === 'session.updated' && !ready) {
            ready = true;
            send({
              type: 'response.create',
              response: {
                output_modalities: ['audio'],
                instructions: speechInstructions,
              },
            });
          }
          if (event.type === 'response.output_audio.delta') append(event.delta);
          if (event.type === 'response.function_call_arguments.done')
            throw new Error('Unexpected tools');
          if (event.type === 'response.done') {
            if (
              !isRecord(event.response) ||
              event.response.status !== 'completed'
            )
              throw new Error('Incomplete response');
            complete();
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        const knownReasons = [
          'Invalid audio',
          'Invalid audio length',
          'Audio limit exceeded',
          'Oversized message',
          'Malformed message',
          'Unexpected tools',
          'Unexpected encoding',
          'Interrupted sample',
          'Unexpected delegation',
          'Incomplete response',
        ];
        fail(
          knownReasons.includes(reason)
            ? `Voice preview failed: ${reason}`
            : 'Voice preview received an invalid provider message',
        );
      }
    });
    socket.on('error', () => fail('Voice preview connection failed'));
    socket.on('close', () =>
      fail('Voice preview connection closed before completion'),
    );
    socket.on('unexpected-response', (request, response) => {
      response.resume();
      request.destroy();
      finish(
        unavailable(
          [401, 403].includes(response.statusCode ?? 0)
            ? 'authentication_required'
            : response.statusCode === 429
              ? 'rate_limited'
              : 'preview_failed',
          'Provider rejected the voice preview connection',
        ),
      );
    });
    if (signal.aborted) cancel();
  });
}

/** Only echo known protocol identifiers, never arbitrary upstream text. */
function providerErrorSummary(error: unknown): string {
  const message = 'Provider rejected the voice preview request';
  if (!isRecord(error)) return message;
  const codes = [
    'unknown_parameter',
    'invalid_parameter',
    'invalid_value',
    'invalid_type',
    'missing_required_parameter',
    'unsupported_parameter',
    'invalid_request_error',
    'invalid_api_key',
    'insufficient_quota',
    'rate_limit_exceeded',
    'server_error',
  ];
  const params = [
    'session',
    'session.model',
    'session.store',
    'session.instructions',
    'session.input',
    'session.delegation',
    'session.audio',
    'session.audio.format',
    'session.audio.output.voice',
    'delegation_id',
    'content',
    'audio',
    'type',
  ];
  const details = [
    typeof error.code === 'string' && codes.includes(error.code)
      ? error.code
      : undefined,
    typeof error.param === 'string' && params.includes(error.param)
      ? error.param
      : undefined,
  ].filter((value) => value !== undefined);
  return details.length ? `${message}: ${details.join(', ')}` : message;
}

/** PCM16 little-endian, mono, 24 kHz; input has already been bounded/validated. */
function pcmWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type CapturedLogEntry,
  createLogger,
  type RootLogger,
} from '@stagewise/logger';

const loggers: RootLogger[] = [];

function attributeMap(record: {
  attributes?: { key: string; value: Record<string, unknown> }[];
}): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    (record.attributes ?? []).map(({ key, value }) => [key, value]),
  );
}

afterEach(async () => {
  await Promise.all(loggers.splice(0).map((logger) => logger.flush()));
});

describe('runtime log schema', () => {
  it('normalizes every structured call to canonical dotted fields', () => {
    const entries: CapturedLogEntry[] = [];
    const logger = createLogger({
      name: 'klex',
      type: 'hidden',
      console: false,
      capture: (entry) => entries.push(entry),
    });
    loggers.push(logger);

    const child = logger.child({ name: 'session-host', bindings: {} });
    child.info(
      {
        sessionId: 'session-1',
        stateFrom: 'idle',
        stateTo: 'working',
        inputTokens: 12,
      },
      'Session state changed',
    );

    expect(entries[0]).toMatchObject({
      message: 'Session state changed',
      fields: {
        'event.name': 'session.host.session.state.changed',
        'logger.name': 'session-host',
        'klex.session.id': 'session-1',
        'klex.session.state.from': 'idle',
        'klex.session.state.to': 'working',
        'gen_ai.usage.input_tokens': 12,
      },
    });
  });

  it('creates TRACE records when an explicit TRACE minimum is combined with capture', () => {
    const entries: CapturedLogEntry[] = [];
    const logger = createLogger({
      name: 'klex',
      type: 'hidden',
      console: false,
      minLevel: 'TRACE',
      capture: (entry) => entries.push(entry),
    });
    loggers.push(logger);

    logger.child({ name: 'generation-runner' }).trace('Generation started');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'TRACE',
      loggerName: 'generation-runner',
      message: 'Generation started',
    });
    // Metadata must not leak into captured structured fields.
    expect(entries[0]?.fields).not.toHaveProperty('_logMeta');
  });

  it('keeps DEBUG as the capture default without an explicit minimum', () => {
    const entries: CapturedLogEntry[] = [];
    const logger = createLogger({
      name: 'klex',
      type: 'hidden',
      console: false,
      verbose: false,
      capture: (entry) => entries.push(entry),
    });
    loggers.push(logger);

    logger.trace('Dropped');
    logger.debug('Kept');

    expect(entries.map((entry) => entry.message)).toEqual(['Kept']);
  });

  it('exports message and fields as proper OTLP body and attributes', async () => {
    const requestBody = Promise.withResolvers<string>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requestBody.resolve(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    try {
      const { port } = server.address() as AddressInfo;
      const logger = createLogger({
        name: 'klex',
        console: false,
        otel: {
          url: `http://127.0.0.1:${port}/v1/logs`,
          resourceAttributes: { 'service.name': 'klex' },
          telemetryLevel: 'advanced',
        },
      });
      loggers.push(logger);

      const child = logger.child({ name: 'session-host', bindings: {} });
      child.info(
        {
          event: 'session.state_changed',
          sessionId: 'session-1',
          stateValue: 1,
          inputTokens: 12,
        },
        'Session state changed',
      );
      await logger.flush();

      const payload = JSON.parse(await requestBody.promise) as {
        resourceLogs: {
          scopeLogs: {
            logRecords: {
              body?: { stringValue?: string };
              attributes?: { key: string; value: Record<string, unknown> }[];
            }[];
          }[];
        }[];
      };
      const record = payload.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
      expect(record?.body?.stringValue).toBe('Session state changed');
      const attributes = attributeMap(record ?? {});
      expect(attributes['event.name']?.stringValue).toBe(
        'session.state_changed',
      );
      expect(attributes['logger.name']?.stringValue).toBe('session-host');
      expect(attributes['klex.session.id']?.stringValue).toBe('session-1');
      expect(attributes['klex.session.state.value']?.intValue).toBe('1');
      expect(attributes['gen_ai.usage.input_tokens']?.intValue).toBe('12');
      expect(attributes['0']).toBeUndefined();
      expect(attributes['1']).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    ['advanced', ['Session state changed', 'Disk low']],
    ['basic', ['Disk low']],
  ] as const)(
    'exports WARN+ plus allowlisted INFO events at %s',
    async (telemetryLevel, expected) => {
      const records = await exportRecords(telemetryLevel, (logger) => {
        const child = logger.child({ name: 'chat-session', bindings: {} });
        child.info(
          { event: 'session.state_changed', sessionId: 'session-1' },
          'Session state changed',
        );
        child.info({ event: 'session.other' }, 'Not allowlisted');
        child.debug({ event: 'session.state_changed' }, 'Below INFO');
        child.info('Free-form info');
        child.warn({ event: 'disk.low' }, 'Disk low');
      });
      // Basic exports no message bodies; compare event names there.
      if (telemetryLevel === 'basic') {
        expect(records.map((r) => attributeMap(r)['event.name'])).toEqual([
          { stringValue: 'disk.low' },
        ]);
      } else {
        expect(records.map((r) => r.body?.stringValue)).toEqual(expected);
      }
    },
  );
});

interface ExportedRecord {
  body?: { stringValue?: string };
  attributes?: { key: string; value: Record<string, unknown> }[];
}

async function exportRecords(
  telemetryLevel: 'basic' | 'advanced',
  emit: (logger: RootLogger) => void,
): Promise<ExportedRecord[]> {
  const records: ExportedRecord[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        resourceLogs: { scopeLogs: { logRecords: ExportedRecord[] }[] }[];
      };
      for (const resource of payload.resourceLogs) {
        for (const scope of resource.scopeLogs) {
          records.push(...scope.logRecords);
        }
      }
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const logger = createLogger({
      name: 'klex',
      console: false,
      minLevel: 'TRACE',
      otel: {
        url: `http://127.0.0.1:${port}/v1/logs`,
        resourceAttributes: { 'service.name': 'klex' },
        telemetryLevel,
        minLevel: 'WARN',
        eventsBelowMinLevel: ['session.state_changed'],
      },
    });
    loggers.push(logger);
    emit(logger);
    await logger.flush();
    return records;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

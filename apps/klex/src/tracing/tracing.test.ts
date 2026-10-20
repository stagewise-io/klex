import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { context, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createTelemetryExportConfiguration } from '@/telemetry-config';
import { createTelemetrySpanProcessor } from '@/telemetry-manager';
import { createTelemetryPolicy } from '@/telemetry-policy';

import { createTracing } from './tracing';

describe('tracing transport', () => {
  it('exports binary OTLP/HTTP Protobuf with the configured endpoint and headers', async () => {
    const requests: {
      method: string | undefined;
      url: string | undefined;
      headers: IncomingHttpHeaders;
      body: Buffer;
    }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
      // An empty message is a valid ExportTraceServiceResponse.
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const configuration = createTelemetryExportConfiguration(
      `http://127.0.0.1:${port}`,
      {
        KLEX_TELEMETRY_HEADERS: JSON.stringify({
          'x-project-name': 'transport-test',
        }),
      },
    );
    const tracing = createTracing({
      logging: createLogger({ name: 'test', type: 'hidden', console: false }),
      otlpUrl: configuration.tracesUrl,
      otlpHeaders: { ...configuration.headers },
      serviceName: 'transport-test',
      spanProcessor: createTelemetrySpanProcessor('debug'),
      policy: createTelemetryPolicy('debug'),
    });
    try {
      await tracing.start();
      const span = trace
        .getTracer('transport-test')
        .startSpan('protobuf-regression');
      const { traceId, spanId } = span.spanContext();
      span.setAttribute('transport.test', 'preserved-attribute');
      span.end();
      await tracing.forceFlush();

      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (!request) throw new Error('No trace export received');
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v1/traces');
      expect(request.headers['content-type']).toBe('application/x-protobuf');
      expect(request.headers['x-project-name']).toBe('transport-test');
      expect(request.body[0]).toBe(0x0a);
      expect(request.body.includes(Buffer.from(traceId, 'hex'))).toBe(true);
      expect(request.body.includes(Buffer.from(spanId, 'hex'))).toBe(true);
      expect(request.body.includes(Buffer.from('protobuf-regression'))).toBe(
        true,
      );
      expect(request.body.includes(Buffer.from('preserved-attribute'))).toBe(
        true,
      );
    } finally {
      await tracing.close();
      trace.disable();
      context.disable();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

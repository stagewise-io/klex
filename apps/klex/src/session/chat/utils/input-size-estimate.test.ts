import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isAllowedTelemetryAttribute } from '@/telemetry-policy';

import type { AgentTools } from '../tools';
import { estimateInputSize } from './input-size-estimate';

const metric = (attributes: Readonly<Record<string, number>>, name: string) =>
  attributes[`klex.input_size.${name}`] ?? 0;

describe('estimateInputSize', () => {
  it('estimates prompt components and counts only numeric, content-free diagnostics', () => {
    const repeatedLine =
      'Keep the request scoped to this workspace and avoid unrelated files.';
    const repeatedIdentifier = '0123456789abcdef';
    const repeatedPath = '/repo/src/klex.ts';
    const repeatedUrl = 'https://docs.example.test/a';
    const privateText = 'SHOULD_NOT_EXPORT_this prompt phrase';
    const modelMessages: ModelMessage[] = [
      {
        role: 'user',
        content:
          'Inspect ' +
          repeatedPath +
          ' with id ' +
          repeatedIdentifier +
          ' and ' +
          repeatedUrl +
          '. ' +
          privateText,
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1234567890abcdef',
            toolName: 'searchMemory',
            input: { query: `find ${repeatedPath}` },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1234567890abcdef',
            toolName: 'searchMemory',
            output: { type: 'text', value: `Found ${repeatedPath}` },
          },
        ],
      },
      {
        role: 'assistant',
        content:
          'Previously referenced ' +
          repeatedPath +
          ' id ' +
          repeatedIdentifier +
          ' and ' +
          repeatedUrl,
      },
      {
        role: 'user',
        content:
          'Retrieved: <memory>Relevant private memory here</memory> Thanks.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'image',
            image: 'data:image/png;base64,DO_NOT_COUNT_IMAGE_BYTES',
          },
          {
            type: 'file',
            data: 'data:application/pdf;base64,DO_NOT_COUNT_FILE_BYTES',
            mediaType: 'application/pdf',
          },
        ],
      } as unknown as ModelMessage,
    ];
    const tools = {
      inspect: {
        description: 'Inspect a file by path.',
        inputSchema: z.object({
          filePath: z.string().describe('File path to inspect'),
        }),
      },
      raw: {
        description: 'Search by identifier.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Opaque identifier' },
          },
        },
      },
    } as unknown as AgentTools;

    const { attributes } = estimateInputSize({
      basePrompt: repeatedLine,
      extensionSystemPromptParts: [repeatedLine],
      modelMessages,
      tools,
    });

    expect(metric(attributes, 'base_instruction_units')).toBeGreaterThan(0);
    expect(metric(attributes, 'extension_instruction_units')).toBeGreaterThan(
      0,
    );
    expect(metric(attributes, 'history_incoming_text_units')).toBeGreaterThan(
      0,
    );
    expect(metric(attributes, 'history_assistant_text_units')).toBeGreaterThan(
      0,
    );
    expect(metric(attributes, 'history_call_payload_units')).toBeGreaterThan(0);
    expect(metric(attributes, 'history_result_payload_units')).toBeGreaterThan(
      0,
    );
    expect(metric(attributes, 'history_memory_text_units')).toBeGreaterThan(0);
    expect(metric(attributes, 'tool_schema_units')).toBeGreaterThan(0);
    expect(metric(attributes, 'estimated_total_units')).toBeGreaterThan(0);
    expect(metric(attributes, 'identifier_units')).toBeGreaterThan(0);
    expect(metric(attributes, 'filepath_units')).toBeGreaterThan(0);
    expect(metric(attributes, 'url_units')).toBeGreaterThan(0);
    expect(metric(attributes, 'identifier_share')).toBeGreaterThan(0);
    expect(metric(attributes, 'filepath_share')).toBeGreaterThan(0);
    expect(metric(attributes, 'url_share')).toBeGreaterThan(0);
    expect(metric(attributes, 'repeated_identifier_units')).toBeGreaterThan(0);
    expect(metric(attributes, 'repeated_filepath_units')).toBeGreaterThan(0);
    expect(metric(attributes, 'repeated_url_units')).toBeGreaterThan(0);
    expect(metric(attributes, 'repeated_line_units')).toBeGreaterThan(0);
    expect(
      metric(attributes, 'repeated_identifier_occurrence_count'),
    ).toBeGreaterThan(0);
    expect(
      metric(attributes, 'repeated_filepath_occurrence_count'),
    ).toBeGreaterThan(0);
    expect(metric(attributes, 'repeated_url_occurrence_count')).toBeGreaterThan(
      0,
    );
    expect(
      metric(attributes, 'repeated_line_occurrence_count'),
    ).toBeGreaterThan(0);
    expect(metric(attributes, 'image_part_count')).toBe(1);
    expect(metric(attributes, 'file_part_count')).toBe(1);
    expect(metric(attributes, 'tool_count')).toBe(2);
    expect(metric(attributes, 'unestimated_tool_component_count')).toBe(0);
    expect(metric(attributes, 'structured_scan_truncated')).toBe(0);
    expect(metric(attributes, 'repeated_line_scan_truncated')).toBe(0);

    const serializedAttributes = JSON.stringify(attributes);
    for (const privateValue of [
      privateText,
      repeatedIdentifier,
      repeatedPath,
      repeatedUrl,
      'Relevant private memory here',
      'DO_NOT_COUNT_IMAGE_BYTES',
      'DO_NOT_COUNT_FILE_BYTES',
    ]) {
      expect(serializedAttributes).not.toContain(privateValue);
    }
    for (const [name, value] of Object.entries(attributes)) {
      expect(typeof value).toBe('number');
      expect(isAllowedTelemetryAttribute(name, 'basic', value), name).toBe(
        false,
      );
      expect(isAllowedTelemetryAttribute(name, 'advanced', value), name).toBe(
        true,
      );
    }
  });

  it('scans long unbroken history with bounded linear work', () => {
    const longAlphaRun = 'z'.repeat(20_000);
    const longHyphenRun = 'z-'.repeat(10_000);
    const { attributes } = estimateInputSize({
      basePrompt: '',
      extensionSystemPromptParts: [],
      modelMessages: [
        { role: 'user', content: `${longAlphaRun} ${longHyphenRun}` },
      ],
      tools: {},
    });

    expect(metric(attributes, 'identifier_units')).toBe(0);
    expect(metric(attributes, 'filepath_units')).toBe(0);
    expect(metric(attributes, 'structured_scan_truncated')).toBe(0);
  });

  it('continues collecting after oversized structured candidates', () => {
    const oversizedUrl = `https://example.com/${'x'.repeat(5_000)}`;
    const oversizedHexRun = 'g'.repeat(20_000);
    const filepath = '/workspace/src/later/file.ts';
    const identifier = '0123456789abcdef';
    const { attributes } = estimateInputSize({
      basePrompt: '',
      extensionSystemPromptParts: [],
      modelMessages: [
        {
          role: 'user',
          content: `${oversizedUrl} ${oversizedHexRun} ${filepath} ${identifier}`,
        },
        { role: 'assistant', content: `${filepath} fedcba9876543210` },
      ],
      tools: {},
    });

    expect(metric(attributes, 'structured_scan_truncated')).toBe(1);
    expect(metric(attributes, 'filepath_units')).toBeGreaterThan(0);
    expect(metric(attributes, 'identifier_units')).toBeGreaterThan(0);
  });
});

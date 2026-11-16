import type { JSONValue, ModelMessage, ToolResultPart } from 'ai';

export const SANDBOX_TOOL_NAME = 'runInSandbox';
/** Bounds model input per sandbox result; extra images stay as JSON text. */
export const MAX_PROJECTED_SANDBOX_IMAGES = 8;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

type ContentOutputItem = Extract<
  ToolResultPart['output'],
  { type: 'content' }
>['value'][number];

interface Projection {
  value: JSONValue;
  images: Array<{ mediaType: string; data: string }>;
}

/**
 * Projects MCP image content returned through `runInSandbox` into native image
 * parts. The sandbox only emits JSON, so an MCP `CallToolResult` with an image
 * would otherwise reach the model as base64 text. Each projected payload is
 * replaced in the JSON by a reference to the attached image.
 */
export function projectSandboxToolMedia(
  messages: ModelMessage[],
): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool') return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (
        part.type !== 'tool-result' ||
        part.toolName !== SANDBOX_TOOL_NAME ||
        part.output.type !== 'json'
      )
        return part;
      const projection: Projection = { value: null, images: [] };
      projection.value = project(part.output.value, projection);
      if (projection.images.length === 0) return part;
      changed = true;
      const value: ContentOutputItem[] = [
        {
          type: 'text',
          text: `${JSON.stringify(projection.value)}\n\nImages referenced by "attachment" follow in order.`,
        },
      ];
      projection.images.forEach((image, index) => {
        value.push({ type: 'text', text: `Attachment ${index + 1}:` });
        value.push({
          type: 'file',
          mediaType: image.mediaType,
          data: { type: 'data', data: image.data },
        });
      });
      return { ...part, output: { type: 'content' as const, value } };
    });
    return changed ? { ...message, content } : message;
  });
}

type JsonObject = { [key: string]: JSONValue | undefined };

function isJsonObject(value: JSONValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function project(value: JSONValue, projection: Projection): JSONValue {
  if (Array.isArray(value))
    return value.map((item: JSONValue) => project(item, projection));
  if (!isJsonObject(value)) return value;
  if (projection.images.length < MAX_PROJECTED_SANDBOX_IMAGES) {
    const image = imageBlock(value);
    if (image) {
      projection.images.push(image);
      const { data: _data, ...rest } = value;
      return { ...rest, attachment: projection.images.length };
    }
    const resource = value.type === 'resource' ? value.resource : undefined;
    if (isJsonObject(resource)) {
      const blob = imageData(resource.blob, resource.mimeType);
      if (blob) {
        projection.images.push(blob);
        const { blob: _blob, ...rest } = resource;
        return {
          ...value,
          resource: { ...rest, attachment: projection.images.length },
        };
      }
    }
  }
  // A null prototype keeps an own "__proto__" key as data.
  const result: Record<string, JSONValue> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = project(item, projection);
  }
  return result;
}

function imageBlock(
  value: JsonObject,
): { mediaType: string; data: string } | null {
  if (value.type !== 'image') return null;
  return imageData(value.data, value.mimeType);
}

function imageData(
  data: JSONValue | undefined,
  mimeType: JSONValue | undefined,
): { mediaType: string; data: string } | null {
  if (typeof data !== 'string' || typeof mimeType !== 'string') return null;
  const mediaType = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!/^image\/[a-z0-9.+-]+$/.test(mediaType)) return null;
  const compact = data.replaceAll(/\s/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !BASE64.test(compact))
    return null;
  return { mediaType, data: compact };
}

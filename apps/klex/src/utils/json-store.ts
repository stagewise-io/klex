import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { z } from 'zod';

type FileName = 'config';

export const getJsonPath = (name: FileName): string =>
  path.join('', `${name}.json`);

export type { FileName };

export async function readPersistedData<T extends z.ZodTypeAny>(
  name: FileName,
  schema: T,
  defaultValue: z.infer<T>,
): Promise<z.infer<T>> {
  const filePath = getJsonPath(name);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return schema.parse(JSON.parse(content));
  } catch {
    return defaultValue;
  }
}

export async function writePersistedData<T extends z.ZodTypeAny>(
  name: FileName,
  schema: T,
  data: z.infer<T>,
): Promise<void> {
  const filePath = getJsonPath(name);
  schema.parse(data);
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, json, 'utf-8');
}

export function readPersistedDataSync<T extends z.ZodTypeAny>(
  name: FileName,
  schema: T,
  defaultValue: z.infer<T>,
): z.infer<T> {
  const filePath = getJsonPath(name);
  try {
    const content = fsSync.readFileSync(filePath, 'utf-8');
    return schema.parse(JSON.parse(content));
  } catch {
    return defaultValue;
  }
}

export function writePersistedDataSync<T extends z.ZodTypeAny>(
  name: FileName,
  schema: T,
  data: z.infer<T>,
): void {
  const filePath = getJsonPath(name);
  schema.parse(data);
  const json = JSON.stringify(data, null, 2);
  fsSync.writeFileSync(filePath, json, 'utf-8');
}

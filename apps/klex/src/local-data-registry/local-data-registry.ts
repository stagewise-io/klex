import {
  CLOUD_ENROLLMENT_STORE_DEFINITION,
  CLOUD_IDENTITY_METADATA_STORE_DEFINITION,
} from '@/cloud-connectivity';
import { CONFIG_STORE_DEFINITION } from '@/config';
import type { LocalDataStoreDefinition } from '@/local-data';
import { MCP_OAUTH_STORE_DEFINITION } from '@/mcp';
import { MODEL_CALL_STORE_DEFINITION } from '@/model-call-logger';

export const KLEX_LOCAL_DATA_STORES = [
  CONFIG_STORE_DEFINITION,
  MODEL_CALL_STORE_DEFINITION,
  MCP_OAUTH_STORE_DEFINITION,
  CLOUD_IDENTITY_METADATA_STORE_DEFINITION,
  CLOUD_ENROLLMENT_STORE_DEFINITION,
] as const satisfies readonly LocalDataStoreDefinition[];

export function createLocalDataRegistry(): readonly LocalDataStoreDefinition[] {
  return KLEX_LOCAL_DATA_STORES;
}

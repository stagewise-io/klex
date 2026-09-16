import {
  CLOUD_ENROLLMENT_STORE_DEFINITION,
  CLOUD_IDENTITY_METADATA_STORE_DEFINITION,
} from '@/cloud-connectivity';
import { CONFIG_STORE_DEFINITION } from '@/config';
import type { LocalDataStoreDefinition } from '@/local-data';
import { MCP_OAUTH_STORE_DEFINITION } from '@/mcp';
import { MODEL_CALL_STORE_DEFINITION } from '@/model-call-logger';
import { TIMEZONE_STORE_DEFINITION } from '@/session/chat/extensions/time';
import { TODOS_STORE_DEFINITION } from '@/session/chat/extensions/todos';

export const KLEX_LOCAL_DATA_STORES = [
  CONFIG_STORE_DEFINITION,
  MODEL_CALL_STORE_DEFINITION,
  MCP_OAUTH_STORE_DEFINITION,
  CLOUD_IDENTITY_METADATA_STORE_DEFINITION,
  CLOUD_ENROLLMENT_STORE_DEFINITION,
  TIMEZONE_STORE_DEFINITION,
  TODOS_STORE_DEFINITION,
] as const satisfies readonly LocalDataStoreDefinition[];

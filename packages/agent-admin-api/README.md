# @klex/agent-admin-api

Shared types for the Klex Bot Admin API.

The package exports the routed Hono application type through `AdminApi` and
`AdminApiServer`, plus the `OpenAPIHono` type used to build RPC clients.

```ts
import { hc } from 'hono/client';
import type { AdminApi } from '@klex/agent-admin-api';

const client = hc<AdminApi>('https://agent.example');
const health = await client.v1.health.$get();
```

Install `hono` and `@hono/zod-openapi` as peer dependencies.

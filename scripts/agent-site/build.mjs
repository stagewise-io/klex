import { createAgentBuild } from './agent-site.mjs';

const kind = process.argv[2];
if (!['marketing', 'docs'].includes(kind))
  throw new Error('Expected marketing or docs');
await createAgentBuild({ kind }).build();

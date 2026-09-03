import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript';

const apiDeclarationUrl = new URL(
  '../../apps/klex/.types/admin-api/admin-api/server.d.ts',
  import.meta.url,
);
const outputDirectoryUrl = new URL('./dist/', import.meta.url);
const declarationOutputUrl = new URL('./index.d.ts', outputDirectoryUrl);

const apiDeclarationText = await readFile(apiDeclarationUrl, 'utf8');
const apiSourceFile = ts.createSourceFile(
  fileURLToPath(apiDeclarationUrl),
  apiDeclarationText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const createAdminApp = apiSourceFile.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === 'createAdminApp',
);
if (!createAdminApp?.type || !ts.isTypeLiteralNode(createAdminApp.type)) {
  throw new Error(
    'Expected createAdminApp to have an object return type containing app',
  );
}
const appProperty = createAdminApp.type.members.find(
  (member) =>
    ts.isPropertySignature(member) &&
    ts.isIdentifier(member.name) &&
    member.name.text === 'app',
);
if (!appProperty?.type) {
  throw new Error('Expected createAdminApp return type to contain app');
}

const adminApiType = appProperty.type
  .getText(apiSourceFile)
  .replaceAll('/:path{.+}', '/:path');
if (
  adminApiType.includes('AppEnv') ||
  adminApiType.includes('@/') ||
  adminApiType.includes('@stagewise/klex')
) {
  throw new Error('Admin API declaration contains private Klex types');
}

const declarationOutput = `export type { OpenAPIHono } from '@hono/zod-openapi';\n\nexport type AdminApi = ${adminApiType};\nexport type AdminApiServer = AdminApi;\n`;

await rm(outputDirectoryUrl, { force: true, recursive: true });
await mkdir(outputDirectoryUrl);
await writeFile(declarationOutputUrl, declarationOutput);

import { serve } from "@hono/node-server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { createLogger } from "./logger";

const PORT = Number(process.env.PORT ?? 3123);
const LOG_LEVEL = (process.env.LOG_LEVEL ?? "INFO") as
  | "TRACE"
  | "DEBUG"
  | "INFO"
  | "WARN"
  | "ERROR"
  | "FATAL";

// Root logger — created once per process before all other modules
const logger = createLogger({ name: "computer", minLevel: LOG_LEVEL });

// createMcpHandler serves both protocol eras from one factory + one endpoint:
//   - 2026-07-28 (modern) via per-request factory instances
//   - 2025-era (legacy) via stateless fallback from the same factory
// Default legacy: 'stateless' — no need to set it explicitly.
const handler = createMcpHandler(() => {
  return new McpServer(
    {
      name: "computer",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );
}, {
  legacy: "stateless",
});

// Hono app with built-in DNS rebinding protection for localhost
const app = createMcpHonoApp();

// Route all MCP traffic through the dual-era handler
app.all("/mcp", (c) => handler.fetch(c.req.raw));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info({ port: info.port }, "MCP server listening");
});

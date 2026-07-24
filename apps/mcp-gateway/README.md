# MCP Gateway

Thin runnable composition of `@stagewise/mcp-gateway-node`.

Required environment variables:

- `MCP_GATEWAY_AGENT_TOKEN`
- `MCP_GATEWAY_ENVIRONMENT_TOKEN`

Optional identity and listener variables: `MCP_GATEWAY_HOST`, `MCP_GATEWAY_PORT`, `MCP_GATEWAY_TENANT_ID`, `MCP_GATEWAY_AGENT_ID`, and `MCP_GATEWAY_ENVIRONMENT_ID`.

The example uses fixed bearer credentials for deployment smoke testing. Put TLS and production identity infrastructure in front of this process.

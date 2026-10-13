# MCP extension client

Shared client infrastructure for Stagewise MCP extensions.

`registerSubscriptionAcknowledgementHandler` dispatches subscription acknowledgements to multiple extensions through one MCP notification handler. Both push notifications and realtime media must use the same installed copy of this package for the same MCP client.

This is a public runtime dependency, not separately bundled into each extension. It has exact peer dependencies on the MCP client SDK and Zod. See the repository's npm release guide for publishing and release scopes.

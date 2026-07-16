Fluid Agent - The self-improving orchestrator agent.

Fluid Agent is a durable, self improving agent that operates wherever you operates: Whatsapp, your MacBook, GitHub, Slack, your iPhone and even participates in a Google Meeting.

Structure: 

apps/
  fluid-agent/        # Reference executable
    core/               # Reasoning and agent-domain behavior. Does NOT allow or include local file access/shell tool capabilities. Mainly brain-behaviour (memory, session management, subagents, etc.)

packages/
  acp-schema/           # ACP plus Fluid extension schemas
  mcp-schema/           # MCP extension (message types that we need that are not part of the standard MCP)

mcp-servers/          
  computer/ # 
  [browser/ ]


<img src="assets/brand/wordmark.png" alt="Klex Bot" width="240">

An isolated agent that excels at memory, self-improvement, and efficient orchestration.

## Quick Start

### Linux, macOS, WSL

```bash
# Install Klex on any machine:
curl -fsSL https://klex-agent.stagewise.io/install.sh | bash

# Start the Klex setup
mkdir my-klex-agent
cd my-klex-agent
klex
```

### Windows
```ps1
# Install Klex
iex (irm https://klex-agent.stagewise.io/install.ps1)

mkdir my-first-klex-agent
cd my-first-klex-agent
klex
```


## Klex is computer-agnostic

By default, Klex only has access to one dedicated, isolated `data-directory` on the machine it's running on. Every other connection to outside environments and machines is established via MCP and an MCP-Extension:

- Talking to you via Telegram, Discord or Slack
- Research on the Internet using Web-Search
- Orchestrating Claude Code agents on another remote VM 
- Updating an Excel-Sheet on your Laptop
- ...

This allows interoperability between various environments, machines and tools you're working with that do not run on the same machine as Klex. Connecting your local Chrome Browser to a remote Klex is just a few clicks; Provisioning a fresh Windows VM to let Klex run platform-specific code can be done in a minute without redeployment; Or letting Klex fix your remote dev server is possible without spawning the Klex on the same machine.


## Klex is self-improving:
After every task, Klex will reflect on its actions - and update its internal understanding and memory to do the task more efficiently the next time.


## Klex is sessionless:
There is no dedicated policy that determines which session an incoming message belongs to - every message is sent into the brain of Klex, where an agentic router decides what to do with the message:
- Delegate to a sub-agent with a smaller/faster model
- Queue the message into an existing conversation
- Provide an immediate quick response without delegating


### Klex is model-aware:
Klex knows about its available models and their tradeoffs:
- Just need to query some info -> Klex will use a flashy model to reduce latency
- Need to do market research -> Klex will use smart, available models to improve accuracy

## License

Klex is licensed under the [Apache License 2.0](LICENSE).

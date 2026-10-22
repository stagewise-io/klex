<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/wordmark-dark.png">
  <img src="assets/brand/wordmark.png" alt="Klex" width="240">
</picture>
<br></br>


Isolated, observable, autonomous bots that **excel at memory and self-improvement**. Tools, machines and coding environments are connected via MCP.

## Installation

<details open>
<summary>Install & Connect to Klex Cloud:</summary>

<br/>You can self-host a Klex Bot and connect it to the Klex Cloud.

**Start here:** https://cloud.klex.bot and locally install the Klex Bot when prompted.

*Why connect it to cloud?*

The cloud provides OOTB app-integrations with **bot-owned identities** and **push-notification support** (E.g. *@My-Bot-123* in Slack which wakes up on a DM or @mention). **Your local Klex Bot still owns all the data** and API keys for inference providers.

Without the cloud, you need to set up reverse-proxies like tailscale or ngrok to receive webhooks from integrations that should wake up your bot. Most of the integrations only exist in cloud, though!
</details>


<details>
<summary>Or install just the local Klex Bot:</summary>

<br/>macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/stagewise-io/klex/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/stagewise-io/klex/main/install.ps1 | iex
```

After installation, you can add models, providers and mcp servers via the Terminal UI or configure their entries in `{data-directory}/config.json` directly. 

Sending messages to the bot requires a connected MCP server with support for `mcp-extension-push-notifications`.
</details>

## Principles 

### A Klex Bot has one permanent session
**All incoming messages enter the same durable default session**. Wherever you chat with the bot, it has the same context. Extensions can explicitly create isolated child sessions when a background-task needs separate context, tools, or model behavior.


### Klex bots are *mcp-native*
The core agent loop is built around mcp-support. **Incoming messages are sent via mcp servers** that implement **`mcp-extension-push-notifications`**. **Realtime calling** is implemented via **`mcp-extension-realtime-media`**.


### Klex bots can't touch their host computer

During runtime, the Klex Bot process **only accesses data in one dedicated, isolated `data-directory`** on its host machine. Connections to outside environments and machines are **established via MCP**. By implementing MCP extensions, **MCP servers can wake-up a Klex Bot (`mcp-extension-push-notifications`) or initiate a voice- and video-call (`mcp-extension-realtime-media`).**


### Klex bots learn and self-improve (and keep their learnings organized)
After every unit of work, **a Klex Bot will reflect** on its actions and conversations - it will **create and organize learnings as skills** to do the task more efficiently the next time and remember preferences.


### You can voice-call Klex Bots
Voice conversations via latest realtime models are **integrated out of the box**. `mcp-extension-realtime-media` lets you initiate a call via MCP - and swill make the bot switch to an agreed-upon realtime protocol (so far, only `LiveKit` is supported).


## Community

- [Join the Discord](https://discord.gg/EWXuzvBj6B)


## License

Klex is licensed under the [Apache License 2.0](LICENSE).

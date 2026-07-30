export function renderChatPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Klex Chat Simulator</title>
  <style>
    :root { font: 13px/1.4 Arial, Helvetica, sans-serif; color: #000; background: #fff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #fff; }
    main { width: min(800px, 100%); min-height: 100vh; margin: 0 auto; display: grid; grid-template-rows: auto 1fr auto; }
    header { padding: 10px 8px; border-bottom: 1px solid #aaa; }
    h1 { margin: 0; font-size: 14px; }
    header p { margin: 2px 0 0; color: #666; font-size: 11px; }
    #messages { overflow-y: auto; padding: 12px 8px; }
    .empty { margin: 0; color: #666; }
    article { position: relative; margin: 0 0 12px; padding-left: 48px; white-space: pre-wrap; overflow-wrap: anywhere; }
    article::before { position: absolute; left: 0; width: 40px; color: #666; font-size: 11px; }
    article.user::before { content: 'user'; }
    article.agent::before { content: 'agent'; }
    article time { display: block; margin-top: 1px; color: #828282; font-size: 10px; }
    form { display: grid; grid-template-columns: 1fr auto; gap: 6px; padding: 8px; border-top: 1px solid #aaa; }
    textarea { resize: vertical; min-height: 54px; max-height: 180px; padding: 3px; color: #000; background: #fff; border: 1px solid #777; border-radius: 0; font: inherit; }
    button { align-self: end; padding: 2px 8px; font: inherit; cursor: pointer; }
    button:disabled { cursor: default; }
    #error { position: fixed; top: 8px; left: 50%; translate: -50% 0; padding: 4px 8px; border: 1px solid #900; background: #fff; color: #900; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <header><h1>Klex Chat Simulator</h1><p>Local environment · MCP endpoint at /mcp</p></header>
    <section id="messages" aria-live="polite"><p class="empty">No messages yet.</p></section>
    <form id="composer"><textarea id="input" maxlength="4000" placeholder="Send a message…" aria-label="Message" required></textarea><button>Send</button></form>
  </main>
  <div id="error" role="alert" hidden></div>
  <script>
    const messages = document.querySelector('#messages');
    const form = document.querySelector('#composer');
    const input = document.querySelector('#input');
    const button = form.querySelector('button');
    const errorBox = document.querySelector('#error');
    const known = new Set();

    function showError(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
      setTimeout(() => { errorBox.hidden = true; }, 4000);
    }
    function append(message) {
      if (known.has(message.id)) return;
      known.add(message.id);
      messages.querySelector('.empty')?.remove();
      const article = document.createElement('article');
      article.className = message.sender;
      article.textContent = message.message;
      const time = document.createElement('time');
      time.dateTime = message.createdAt;
      time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      article.append(time);
      messages.append(article);
      messages.scrollTop = messages.scrollHeight;
    }
    async function load() {
      const response = await fetch('/api/messages');
      if (!response.ok) throw new Error('Could not load messages');
      const body = await response.json();
      body.messages.forEach(append);
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = input.value.trim();
      if (!message) return;
      button.disabled = true;
      try {
        const response = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? 'Could not send message');
        append(body.message);
        input.value = '';
      } catch (error) { showError(error.message); }
      finally { button.disabled = false; input.focus(); }
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
    });
    load().catch((error) => showError(error.message));
    const stream = new EventSource('/api/stream');
    stream.addEventListener('message', (event) => append(JSON.parse(event.data)));
    stream.onerror = () => showError('Live connection interrupted; reconnecting…');
  </script>
</body>
</html>`;
}

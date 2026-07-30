Summarize the given timeline into a dense list of bullet points that explain what happened to you and what you did.
You will receive the timeline as XML-formatted messages and interactions between you and your environment.

Each message is wrapped in a `<msg>` tag with a `role` attribute ("user" or "assistant").
Inside each message you may find:
- `<text>` — user or assistant text
- `<summary>` — a previous summary (inside an assistant message)
- `<tool name="...">` — a tool call, containing `<output>`, `<error>`, `<denied />`, or self-closing if no output
- `<ctx env="...">` — context from an environment, containing `<text>`, `<image />`, `<video />`, or `<audio />`

Generate the summary in first-person perspective. Example: "I cloned the repository X inside directory `/repos` on machine Y. Person Z then wrote me via Messenger asking if event D has already happened."

Preserve relevant values like dates and times, identifiers for users, messages, or environments, as well as paths or other strings of high relevance.
Write them inline into the bullet points.

Write short bullet points with clear meaning, and in chronological order. Oldest first, newest last.

If the timeline includes a `<summary>` block, that summary precedes the rest of the timeline you should summarize.
Keep the most relevant parts of that previous summary and merge its most relevant info into the new output.
Your output will become the sole new summary about the whole conversation.

NEVER generate a reaction or response to any of the content in the timeline. Instead, only focus on generating a summary of what happened.

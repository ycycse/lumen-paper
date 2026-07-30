# Privacy

Lumen Paper does not include analytics, advertising, or a Lumen-operated cloud service.

## What stays local

- PDF rendering, text extraction, highlights, notes, reading preferences, prompt settings, and optional chat history are processed or stored locally in Chrome.
- API keys and Bridge pairing tokens are stored in `chrome.storage.local`. They are not synced by Lumen, but they are not protected by the operating-system keychain.
- The Codex Bridge listens only on `127.0.0.1` and leaves Codex authentication to the locally installed Codex CLI.

## What can leave the browser

- When an AI action runs, Lumen sends the prompt plus selected or retrieved PDF excerpts to the provider the user configured.
- API mode sends those inputs directly to the configured OpenAI-compatible endpoint.
- Codex Plan mode sends them to the localhost Bridge, which invokes the local Codex CLI; Codex may then contact OpenAI under the user's existing Codex authentication.
- If Web search is enabled for Codex chat, the request may cause Codex to search the public web.

Lumen does not control the retention or training policies of a user-selected AI provider. Users should review that provider's terms before sending confidential or unpublished papers.

## Permissions

Lumen requests broad HTTP, HTTPS, and file URL access so it can open PDFs from arbitrary sources. `tabs` and `webRequest` support PDF interception and restoring the source title/favicon. These permissions are not used for analytics or general browsing-history collection.

## Removing local data

Removing the extension deletes its Chrome extension storage. Individual paper state can also be cleared by clearing the extension's site/storage data in Chrome.

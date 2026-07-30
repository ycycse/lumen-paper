<p align="right">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <img src="public/icons/icon-128.png" width="76" alt="Lumen Paper icon">
</p>

<h1 align="center">Lumen Paper</h1>

<p align="center">
  A local-first, bring-your-own-model Chrome PDF reader.
</p>

<p align="center">
  Read structured AI briefs beside a PDF, ask about selected passages, highlight, take notes, and follow page citations back to the source.
</p>

<p align="center">
  <a href="https://github.com/ycycse/lumen-paper/releases/latest"><strong>Download the latest release</strong></a>
  · <a href="#installation">Installation</a>
  · <a href="#codex-bridge">Codex Bridge</a>
  · <a href="https://github.com/ycycse/lumen-paper/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/ycycse/lumen-paper/actions/workflows/ci.yml"><img src="https://github.com/ycycse/lumen-paper/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-879b46?style=flat-square" alt="MIT License"></a>
</p>

Lumen Paper replaces Chrome's default PDF page with a focused reading workspace that keeps the paper and AI assistance in the same tab. PDFs are parsed locally in the browser. There are no accounts, analytics, or built-in cloud services: you choose the model, prompts, and permission level.

<a href="docs/lumen-reader.png">
  <img src="docs/lumen-reader.png" alt="A synthetic research paper and its Paper Brief shown side by side">
</a>

<p align="center"><sub>The AI panel sits beside the PDF. Resize it, enlarge its content, collapse it, or enter Focus mode.</sub></p>

## Features

- **Paper Brief** — distills contributions, mechanisms, evidence, limitations, and a suggested reading path.
- **Selection-aware chat and page citations** — quote a passage and ask anything, or translate it directly, then jump back to the referenced page.
- **Highlights and notes** — stored locally per paper without modifying the original PDF.
- **Comfortable reading** — tune the sidebar, content width, type size, font, and Focus mode.
- **Two AI backends** — connect any OpenAI-compatible API or use Codex CLI through the local Bridge.
- **Transparent configuration** — choose separate models for briefs and chat; inspect, edit, and restore every project prompt.

## Interface

<sub>These screenshots come from the real extension and a locally generated synthetic paper. All titles, authors, prose, charts, and measurements shown in the paper are fictional. Click an image to view it at full size.</sub>

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/lumen-highlights.png"><img src="docs/lumen-highlights.png" alt="Highlights and margin notes on a PDF page"></a>
      <br><sub><strong>Highlights and notes</strong>: keep evidence in the paper and your judgment in the margin.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/lumen-chat.png"><img src="docs/lumen-chat.png" alt="AI conversation grounded in paper evidence"></a>
      <br><sub><strong>Evidence-aware chat</strong>: retain context and follow clickable page citations.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/lumen-codex-settings.png"><img src="docs/lumen-codex-settings.png" alt="API, Codex Bridge, model, and permission settings"></a>
      <br><sub><strong>Backends and permissions</strong>: configure APIs, Codex, models, and tool access explicitly.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/lumen-prompt-studio.png"><img src="docs/lumen-prompt-studio.png" alt="Editable prompts in Prompt Studio"></a>
      <br><sub><strong>Prompt Studio</strong>: every project prompt is visible, editable, and restorable.</sub>
    </td>
  </tr>
</table>

## Installation

1. Open the [latest release](https://github.com/ycycse/lumen-paper/releases/latest), then download and unzip the extension archive.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the directory that contains `manifest.json`.
4. Open Lumen settings and configure an AI backend.

If local PDFs do not open in Lumen automatically, enable **Allow access to file URLs** on the extension details page, or open a file from Lumen manually. The extension is not yet available in the Chrome Web Store.

To build from source:

```bash
git clone https://github.com/ycycse/lumen-paper.git
cd lumen-paper
npm ci
npm run build
```

Then load `dist/` from `chrome://extensions`.

## AI backends

| | OpenAI-compatible API | Codex CLI |
|---|---|---|
| Requires | Endpoint, model, and API key | Node.js 22+, a signed-in Codex CLI, and the local Bridge |
| Local process | No | Yes |
| Best for | Lightweight briefs and conversation | Web search, computation, and agent workflows |
| Credentials | Key stays in Chrome local storage | Codex sign-in stays inside the CLI |

Both backends let you select separate models for Paper Brief and chat. API mode can fetch a model list from the configured endpoint and also accepts a model name manually.

## Codex Bridge

The Bridge forwards extension requests to Codex CLI on your machine and listens only on `127.0.0.1`. You do not need it when using API mode.

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://github.com/ycycse/lumen-paper/releases/latest/download/install-lumen-paper-bridge.sh | bash
```

The installer never uses `sudo`. It verifies the version and SHA-256 checksum of the Bridge archive, installs it into your user account, starts the Bridge in the background, copies the pairing token, and returns control to your shell.

Common commands:

```bash
~/.local/bin/lumen-paper-bridge start
~/.local/bin/lumen-paper-bridge status
~/.local/bin/lumen-paper-bridge pair
~/.local/bin/lumen-paper-bridge restart
~/.local/bin/lumen-paper-bridge stop
```

On macOS, the first start copies the pairing token automatically. Upgrades safely restart an installer-managed Bridge without changing that token.

The Bridge runs as a background process after installation. Reader, Agent, and Full Agent are per-request permission profiles selected in Lumen settings. Changes apply to the next chat request immediately, without managing or restarting the local process.

| Profile | Permissions |
|---|---|
| Reader | Runs in a read-only temporary directory and ignores user Codex config and rules |
| Agent | Loads Codex config, rules, skills, and MCP tools; uses `workspace-write` inside an existing absolute, non-root workspace selected in Lumen |
| Full Agent | No sandbox and no approvals; requires explicit confirmation in Lumen |

Full Agent is not root and never requires `sudo`, but it can access anything available to your current user. Its selected workspace is the starting directory, not a security boundary. Use it only for trusted tasks. See the [Security Policy](SECURITY.md) for the complete boundary.

## Data and privacy

- PDFs are parsed locally; relevant text is sent only when you invoke an AI action.
- Briefs, highlights, notes, reading preferences, and optional chat history are stored locally per paper.
- API keys live in `chrome.storage.local`. They are not synced to your Chrome account, but they are not protected by the operating system keychain.
- The Bridge accepts loopback requests only and verifies both the extension origin and pairing token.
- Automatic Paper Brief generation always uses the read-only Reader profile and never receives the configured workspace.

See [Privacy](PRIVACY.md) and the [Security Policy](SECURITY.md).

## Development

```bash
npm run check
npm test
npm run build
npm run bridge:check
```

Run `npm run package` to create a release archive. For a real-browser smoke test, run `npm run smoke -- /absolute/path/to/paper.pdf`.

Current limitations: scanned PDFs have no OCR; figures, formulas, and images are not yet included in vision requests; retrieval uses lightweight lexical ranking; highlights are not written back as PDF annotation objects.

## Contributing

The code for this project was developed by **Codex** and is maintained through human-agent collaboration. Contributions from both people and coding agents are welcome; agent-generated pull requests are first-class contributions here.

We are especially interested in:

- more natural paper reading, evidence navigation, citation, and note-taking workflows;
- new model providers, agent workflows, and research-tool integrations;
- PDF compatibility, performance, accessibility, and local-first privacy improvements;
- small, interesting experiments that clearly state the problem they solve and how their value can be tested.

To contribute:

1. Describe the problem or idea in [GitHub Issues](https://github.com/ycycse/lumen-paper/issues); small fixes may go directly to a pull request.
2. Keep changes focused. Include screenshots for interface work and document permission boundaries plus validation for agent behavior.
3. Run `npm run check` and `npm test` before submitting. If an agent did most of the work, mention the agent, key design decisions, and human verification in the pull request.

## License

Lumen Paper's original source code and project assets are available under the [MIT License](LICENSE). Third-party software remains subject to its own licenses; see [Third-Party Notices](public/THIRD_PARTY_NOTICES.txt).

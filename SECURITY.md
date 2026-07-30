# Security Policy

Only the latest published Lumen Paper release receives security fixes.

Please report vulnerabilities through GitHub's private vulnerability reporting flow under the repository's **Security** tab. Do not post API keys, Bridge pairing tokens, Codex authentication files, private paper text, or exploit details in a public issue.

The optional Codex Agent and Full Agent profiles can execute tools against a local workspace. Full Agent deliberately disables the Codex sandbox and approval prompts; use it only for conversations you initiated, with trusted PDFs, prompts, MCP servers, and workspace contents. Automatic Paper Brief generation always remains on the read-only Reader profile.

The published Bridge installer is version-pinned, verifies the Release archive SHA-256, writes only to the current user's directories, and never uses `sudo`. Because `curl | bash` still executes remote code, users who need a stronger review boundary should download and inspect `install-lumen-paper-bridge.sh` before running it, or use the Bridge ZIP directly.

# Lumen Paper Codex Bridge

Bridge 是 Lumen Paper 与本机 Codex CLI 之间的透明适配器。它不需要 `npm install`，也不会读取或复制 Codex 的登录文件。

## macOS：双击启动

1. 确认本机已有 Node.js 22+，并执行过 `codex login`。
2. 双击 `Start Lumen Paper Bridge.command`。
3. Bridge 会在后台启动，pairing token 会自动复制；到 Lumen 设置页粘贴即可。

若 macOS 阻止直接双击，请右键文件并选择「打开」。不要关闭 Gatekeeper，也不需要执行 `xattr -dr`。

## Terminal

```bash
./lumen-paper-bridge start
```

Bridge 只有一种运行模式。常用命令：

```bash
./lumen-paper-bridge status
./lumen-paper-bridge pair
./lumen-paper-bridge restart
./lumen-paper-bridge stop
```

`start` 会在后台启动并返回当前终端；`restart` 用于更新后切换到新版本；`pair` 会在 macOS 复制 token。需要排查问题时，可用 `./lumen-paper-bridge foreground` 临时查看实时日志。

## 权限在页面切换

Reader、Agent 和 Full Agent 不再对应不同启动命令。请在 Lumen 设置页选择：

- `Reader`：只读临时目录，忽略用户 config 与 rules。
- `Agent`：加载 Codex config、rules、skills 与 MCP，并以 `workspace-write` 使用页面中填写的绝对 workspace。
- `Full Agent`：关闭 sandbox 与审批；页面 workspace 只是起始目录，并非访问边界。仅用于你主动发起且输入可信的任务；仍以当前用户身份运行，不需要 `sudo`。

切换后下一次交流立即生效，不需要重启 Bridge。自动 Paper Brief 始终强制使用 Reader，不会继承 Agent、Full Agent 或 workspace。

## 本机边界

- 只监听 `127.0.0.1`。
- 只接受 Lumen 固定 extension origin。
- 每个请求还需要本机生成的 32-byte pairing token。
- 安装版的 token 保存在稳定的用户 state 目录，升级 Bridge 不需要重新配对。
- Bridge 在当前用户下后台运行；PID 与只含运行状态的日志保存在 state 目录，可用 `stop` 完整停止。

详见项目的 `PRIVACY.md` 与 `SECURITY.md`。

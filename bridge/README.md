# Lumen Paper Codex Bridge

Bridge 是 Lumen Paper 与本机 Codex CLI 之间的透明适配器。它不需要 `npm install`，也不会读取或复制 Codex 的登录文件。

## macOS：双击启动

1. 确认本机已有 Node.js 22+，并执行过 `codex login`。
2. 双击 `Start Lumen Paper Bridge.command`。
3. 把终端显示的 pairing token 粘贴到 Lumen 设置页；终端保持开启。

若 macOS 阻止直接双击，请右键文件并选择「打开」。不要关闭 Gatekeeper，也不需要执行 `xattr -dr`。

## Terminal

```bash
./lumen-paper-bridge start
```

常用命令：

```bash
./lumen-paper-bridge status
./lumen-paper-bridge pair
./lumen-paper-bridge agent --workspace /absolute/path
./lumen-paper-bridge full --workspace /absolute/path
```

- `start` / `reader`：默认只读 Reader；使用临时工作目录。
- `agent`：加载 Codex config、rules、skills 与 MCP，并允许写入显式 workspace。
- `full`：关闭 sandbox 与审批，仅用于你主动发起且输入可信的任务。

自动 Paper Brief 始终使用 Reader。扩展无法单方面解锁 Agent 或 Full Agent。

## 本机边界

- 只监听 `127.0.0.1`。
- 只接受 Lumen 固定 extension origin。
- 每个请求还需要本机生成的 32-byte pairing token。
- 安装版的 token 保存在稳定的用户 state 目录，升级 Bridge 不需要重新配对。
- 默认前台运行；按 `Ctrl-C` 即可停止，不会安装后台常驻服务。

详见项目的 `PRIVACY.md` 与 `SECURITY.md`。

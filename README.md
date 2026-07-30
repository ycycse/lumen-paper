# Lumen Paper

当前版本：**v0.1.17**。阅读器使用轻量专注模式、温暖纸张视觉与针对中英混排重新校准的阅读排版；交流默认使用“研究模式”，当前论文只是可选上下文。Prompt Studio 完整展示并允许修改 Lumen/Bridge 添加的 10 组 prompt；Codex 交流可选择 Reader、Agent 或显式解锁的 Full Agent 权限。

一个安静的 Chrome AI 论文阅读器：PDF 是主角，AI 待在页边。参考 Sider 的随手问答和 Moonlight 的论文专用导航，但把交互收敛成三个低负担动作：**打开即解读、划线即追问、回答必回原文页码**。

![Lumen reader](docs/lumen-reader.png)

## 已实现

- 打开 PDF 自动进入 Lumen：Chrome 150 走 `webRequest` fallback，Chrome 151+ 使用原生 `mime_types_handler`。
- PDF.js 本地解析、canvas 渲染和可选择 text layer。
- 顶部「专注」按钮或 `F` 键可暂时收起 AI 与次要控件，只保留论文标题、页码进度和退出入口；`Esc` 退出并恢复原侧栏状态。
- 阅读舞台采用低刺激暖灰、暖白纸张和柔和实体阴影；AI 长回答限制舒适行宽，宽侧栏不再把一行拉满整屏。
- AI 正文默认采用一致的系统字体 metrics，约 16.5px；正文宽度会随侧栏拖动连续变化。`Aa` 菜单提供舒适、宽屏与铺满三档内容宽度，铺满模式只保留约 16px 安全边距。
- `Aa` 可在系统、书卷与自定义本机字体之间切换；自定义字体名与选择保存在本地，字体未安装或留空时自动回退到系统字体，且不会改变 PDF 原文渲染。
- 尊重系统的“减少动态效果”设置，自动关闭加载 shimmer、跳点和页码定位动画。
- 自动生成 Paper Brief：verdict、贡献、机制、证据账本、局限、最短阅读路径。
- 解读栏可拖动左边界自由加宽，宽度会保留；双击边界恢复默认宽度。
- 浏览器 Tab 保留论文标题；顶部常驻显示当前 `Codex Plan / API`，可直接切换推理入口。
- 图标使用“论文页边 + evidence highlight”语义，不再采用容易撞脸通用 AI 品牌的字母与星芒组合。
- 自动接管前读取当前标签页 favicon 并传入阅读器；获取不到时使用论文来源站 favicon，Lumen 图标只作为最终兜底。
- PDF 文档解析完成后立即显示；只渲染视口附近页面，全文文字索引在后台逐页建立，不再阻塞阅读界面。
- 网络 PDF 字节与文字索引缓存在扩展 IndexedDB（最多 4 篇、7 天）；刷新优先恢复缓存，并为远程读取设置 60 秒超时。
- 顶部 `Aa` 提供紧凑、标准、舒适、大字四档字号；AI 回复以阅读卡片渲染标题、列表、引用、代码和表格。
- `Aa` 还提供连续 `− / +` 调节；PDF 的 `+` 不再封顶 180%，侧栏可一直拖到视窗仅剩 48px。
- 选中文字后直接：解释、翻译、reviewer challenge、四种颜色划线。
- 回答使用 `[[p:N]]` 原文锚点，点击可回到 PDF 页。
- 设置页可直接修改 Paper Brief 的解读偏好并一键恢复默认；JSON、grounding 和页码输出约束仍由 Lumen 固定保留。
- 本地保存每篇论文的摘要、划线、页边笔记和可选对话历史。
- 自定义 OpenAI-compatible Chat Completions API。
- Codex Plan 模式：通过本机 Codex CLI bridge 复用 ChatGPT 登录，不向扩展暴露 Codex token。
- API 模式从 endpoint 对应的 `/models` 动态读取模型；Codex 模式通过 Bridge 查询当前账号实际可用的 Codex 模型，失败时仍允许手动输入。
- Paper Brief 与交流/划线问答拥有独立模型设置；旧版单模型配置首次读取时会无损复制到两个用途。
- Codex 可按设置调用第一方 Web search 与自包含计算命令；Bridge 使用 `codex exec --json` 解析真实工具事件，回答中显示 `Web search ×N / 计算验证 ×N`，不是由模型自报。
- Codex bridge 会复用相同的并发请求；不同 PDF / 不同问题各自启动独立的 `codex exec` 子进程并行处理。
- 交流栏可随时切换“论文 / 研究”语境；研究模式只在问题确实涉及当前论文时附上相关页段，因此可以自然讨论 Kimi、新论文、外部相关工作或一般技术问题。
- Prompt Studio 展示论文 system prompt、研究 system prompt、Paper Brief、普通聊天、三种划线动作、Codex runtime 与连接测试的完整模板；所有字段可逐项编辑、置空和恢复默认。
- Codex 权限明确分为 Reader（read-only）、Agent（workspace-write，加载用户 config/rules/skills/MCP）与 Full Agent（无 sandbox/审批）。每条回答显示实际 runtime receipt。

## 下载 Release 安装

1. 下载 [Lumen Paper v0.1.17 扩展 ZIP](https://github.com/ycycse/lumen-paper/releases/download/v0.1.17/lumen-paper-extension-v0.1.17.zip) 并解压。
2. 打开 `chrome://extensions`，开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的解压目录。
4. 点击扩展图标进入设置，填写自己的 OpenAI-compatible API 配置即可试用。

Release ZIP 只包含可加载的 Chrome 扩展，不包含本机 Codex Bridge。需要 Codex Plan 模式时，请按下一节获取源码并在项目根目录启动 Bridge。

## 从源码安装

```bash
git clone https://github.com/ycycse/lumen-paper.git
cd lumen-paper
npm ci
npm run build
```

然后在 `chrome://extensions` 选择生成的 `dist/` 目录。源码模式同时包含 `npm run bridge` 所需的本机 Bridge。

本机 PDF：

- Chrome 151+ 的原生 MIME handler 可直接处理 `file://` PDF。
- Chrome 150 若想自动接管本地 PDF，需要在扩展详情页开启「允许访问文件网址」；也可以随时从 Lumen 内选择文件，不需要该权限。

## 配置自定义 API

设置页选择「自定义 API」，填写：

- Chat Completions endpoint，例如 `https://api.openai.com/v1/chat/completions`
- 论文解读 / 总结模型
- 交流 / 划线问答模型
- API key

点击模型框会从 Chat Completions endpoint 对应的 `/models` 自动读取列表。也可以使用 OpenRouter、Ollama 或内部网关；如果网关没有模型列表接口，仍可手动输入模型名。生成请求需要兼容 OpenAI Chat Completions 的 `messages` / `choices[0].message.content` 结构。

API key 保存在 `chrome.storage.local`，不会同步到 Chrome 账号。它不是系统钥匙串加密存储；如果要公开分发，建议把直连 API 替换为自己的鉴权后端。

完整数据边界见 [Privacy](PRIVACY.md)。

## 配置 Codex Plan

ChatGPT subscription 不能直接当普通 API key 使用。Lumen 采用本机 programmatic path：bridge 调用已经登录的 `codex exec`。

```bash
codex login status
npm run bridge
```

bridge 启动后会显示一次 pairing token。把它粘贴到 Lumen 设置页，点击「测试连接」。默认命令只开放 Reader profile。
点击 Codex 模型框时，Bridge 会通过 Codex app-server 的 `model/list` 读取当前账号实际可见的模型；解读和聊天可分别指定，留空则跟随 Codex 当前默认模型。Codex 面板还可分别关闭 Web search 和计算验证。升级 Bridge 后需要重启一次进程。
终端里的 `start / join / done` 会显示当前任务进度；同一个请求只会消耗一次 Codex 调用。

需要更完整的 Codex agent 能力时，必须从 Bridge 端显式解锁，扩展页面不能单方面提权：

```bash
# 加载用户 Codex config、rules、skills、MCP；可写指定 workspace
npm run bridge:agent -- --workspace /absolute/path/to/workspace

# 无 sandbox、无审批；只用于你主动发起且完全信任的请求
npm run bridge:full -- --workspace /absolute/path/to/workspace
```

Paper Brief 无论设置如何都固定走 Reader profile，避免打开 PDF 后的自动任务继承 Agent/Full Agent 权限。

安全边界：

- 只监听 `127.0.0.1:43177`；需要 256-bit pairing token，并精确限制为 manifest 公钥对应的 Lumen extension ID。
- Reader 使用 `--sandbox read-only --ask-for-approval never --ephemeral`，在空临时目录运行并忽略 user config / exec rules。
- Agent 使用 `workspace-write`，会加载你的 Codex config、rules、skills 与 MCP；Bridge 启动参数决定其唯一 workspace。
- Full Agent 使用 Codex 官方的 `--dangerously-bypass-approvals-and-sandbox`。它可以执行 shell、读写本机文件、读取进程环境并触发 MCP 外部副作用；只应在理解 prompt injection 风险后主动启用。
- “允许计算”开关属于可见、可编辑的 runtime prompt 约束；真正的命令/文件权限以 Reader、Agent、Full Agent profile 为准。
- bridge 不读取、不复制 `~/.codex/auth.json`；认证完全交给 Codex CLI。

Prompt Studio 能透明展示的是 **Lumen 与 Bridge 自己添加的 prompt**。OpenAI/Codex 服务内部的 system/developer instructions 不会暴露给扩展，也无法由扩展覆盖。

Codex 本质上仍是 coding agent。它适合复用现有 Codex 额度做个人本机阅读，但在纯论文理解的 latency/quality/cost 上，通用模型 API 可能更合适。

## 开发与验证

环境要求：Node.js 22+、npm，以及 Chrome 或 Chrome for Testing。

```bash
npm ci
npm run check
npm test
npm run build
```

真实扩展 smoke（需要支持 `--load-extension` 的 Chromium / Chrome for Testing）：

```bash
npm run smoke -- /absolute/path/to/paper.pdf

# Chrome 不在默认安装位置时：
CHROME_BIN="/path/to/Chrome for Testing" npm run smoke -- /absolute/path/to/paper.pdf
```

当前 smoke 在一篇 53 页论文上验证：53 个页面、canvas 渲染、8,536 个 text spans、selection toolbar 和持久化 highlight overlay。

## 架构

```text
PDF navigation
  ├─ Chrome 151+ mimeHandler stream (single-use response)
  └─ Chrome 150 webRequest fallback / manual file picker
         ↓
PDF.js viewer → per-page text index → lexical page retrieval
         ↓                         ↓
local highlights/notes       Paper Brief / selection / chat prompts
         ↓                         ↓
chrome.storage.local      service worker provider boundary
                                  ├─ OpenAI-compatible API
                                  └─ localhost Codex bridge → codex exec
```

## 目前边界

- 扫描版 PDF 暂无 OCR。
- 表格、公式、图片当前只读 text layer；下一版可加入 page crop / vision 请求。
- 问答检索是轻量 lexical rank，不是 embedding/RAG。
- 划线存为 Lumen 的 normalized page rect，不会写回 PDF annotation object。
- 还没有引用卡片、跨论文 library 和 Markdown/Zotero 导出。

## 仓库安全

- `bridge/.token`、`.env*`、私钥、构建产物和本机 smoke 工作目录均被 `.gitignore` 排除。
- 不要把 API key、Bridge pairing token、Codex 登录文件或真实论文 PDF 提交到 issue、日志或仓库。
- 发布扩展前请重新执行 `npm run check && npm test && npm run build`，并检查 `dist/manifest.json` 的权限变化。
- 安全问题请通过 GitHub 的私密渠道联系仓库维护者，不要在公开 issue 中附带凭证或论文原文。

## 产品判断

- Sider 值得借的是“选中即问、始终不离开当前页面”，不是多模型入口堆叠。
- Moonlight 值得借的是“novelty / method / result + 原文回跳”，不是让 AI summary 抢占阅读。
- Lumen 的差异点应继续强化 **claim–evidence anchoring**：AI 输出只有在能回到原文 span 时才算完成。

## 参考

- [Sider Chat](https://sider.ai/chat)
- [Moonlight: What’s Moonlight?](https://docs.themoonlight.io/articles/4008366-whats-moonlight)
- [Moonlight Highlight](https://docs.themoonlight.io/help/articles/9085677-highlight)
- [Chrome `mimeHandler` API](https://developer.chrome.com/docs/extensions/reference/api/mimeHandler)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

## License

Lumen Paper 自有源码与项目资产使用 [MIT License](LICENSE)。第三方软件仍适用各自许可证，详见 [Third-Party Notices](public/THIRD_PARTY_NOTICES.txt)。

Lumen Paper 是独立项目，与 Sider、Moonlight、OpenAI 或 Google Chrome 不存在隶属或官方背书关系。截图中的论文版权归原作者所有，仅用于展示阅读器界面。

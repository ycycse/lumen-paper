import { Check, ChevronDown, ChevronRight, CircleAlert, Code2, Copy, Eye, EyeOff, KeyRound, LoaderCircle, RefreshCw, RotateCcw, Save, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_CHALLENGE_TEMPLATE,
  DEFAULT_CHAT_TEMPLATE,
  DEFAULT_CODEX_RUNTIME_PROMPT,
  DEFAULT_CONNECTION_TEST_PROMPT,
  DEFAULT_EXPLAIN_TEMPLATE,
  DEFAULT_PAPER_SYSTEM_PROMPT,
  DEFAULT_RESEARCH_SYSTEM_PROMPT,
  DEFAULT_SUMMARY_INSTRUCTIONS,
  DEFAULT_SUMMARY_TEMPLATE,
  DEFAULT_TRANSLATE_TEMPLATE,
} from "../lib/prompts";
import { DEFAULT_SETTINGS, getSettings, saveSettings } from "../lib/storage";
import type { AiResponse, LumenSettings, ModelListResponse, ModelOption, ProviderKind } from "../types";

type TestState = "idle" | "testing" | "ok" | "error";
type CatalogState = "idle" | "loading" | "ok" | "error";
const BRIDGE_INSTALL_COMMAND = "curl --proto '=https' --tlsv1.2 -fsSL https://github.com/ycycse/lumen-paper/releases/latest/download/install-lumen-paper-bridge.sh | bash";

export function OptionsApp() {
  const [settings, setSettings] = useState<LumenSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [bridgeCommandCopied, setBridgeCommandCopied] = useState(false);
  const [fullAccessConfirmed, setFullAccessConfirmed] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [testMessage, setTestMessage] = useState("");
  const [catalog, setCatalog] = useState<{ provider?: ProviderKind; state: CatalogState; models: ModelOption[]; error: string }>({
    state: "idle",
    models: [],
    error: "",
  });

  useEffect(() => {
    void getSettings().then((value) => {
      setSettings(value);
      setFullAccessConfirmed(value.codexPermissionMode === "unrestricted");
      setLoaded(true);
    });
  }, []);

  const patch = <K extends keyof LumenSettings>(key: K, value: LumenSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    if (["provider", "endpoint", "apiKey", "bridgeUrl", "bridgeToken"].includes(key)) {
      setCatalog({ state: "idle", models: [], error: "" });
    }
    setSaved(false);
    setTestState("idle");
  };

  const loadModels = async (force = false) => {
    if (catalog.state === "loading") return;
    if (!force && catalog.provider === settings.provider && catalog.state === "ok") return;
    const provider = settings.provider;
    setCatalog({ provider, state: "loading", models: [], error: "" });
    try {
      const response = await chrome.runtime.sendMessage({
        type: "LIST_MODELS",
        payload: {
          provider,
          endpoint: settings.endpoint,
          apiKey: settings.apiKey,
          bridgeUrl: settings.bridgeUrl,
          bridgeToken: settings.bridgeToken,
        },
      }) as ModelListResponse;
      if (!response.ok || !response.models?.length) throw new Error(response.error || "没有可用模型");
      setCatalog({ provider, state: "ok", models: response.models, error: "" });
    } catch (cause) {
      setCatalog({
        provider,
        state: "error",
        models: [],
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const persist = async () => {
    await saveSettings(settings);
    const mimeHandler = (chrome as typeof chrome & {
      mimeHandler?: {
        setMimeHandlerOptions: (mimeType: string, options: { enabled: boolean }) => Promise<void>;
      };
    }).mimeHandler;
    if (mimeHandler) {
      await mimeHandler.setMimeHandlerOptions("application/pdf", { enabled: settings.autoOpenPdfs });
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  const resetPrompts = () => {
    setSettings((current) => ({
      ...current,
      summaryPrompt: DEFAULT_SUMMARY_INSTRUCTIONS,
      paperSystemPrompt: DEFAULT_PAPER_SYSTEM_PROMPT,
      researchSystemPrompt: DEFAULT_RESEARCH_SYSTEM_PROMPT,
      summaryTemplate: DEFAULT_SUMMARY_TEMPLATE,
      chatTemplate: DEFAULT_CHAT_TEMPLATE,
      explainTemplate: DEFAULT_EXPLAIN_TEMPLATE,
      translateTemplate: DEFAULT_TRANSLATE_TEMPLATE,
      challengeTemplate: DEFAULT_CHALLENGE_TEMPLATE,
      codexRuntimePrompt: DEFAULT_CODEX_RUNTIME_PROMPT,
      connectionTestPrompt: DEFAULT_CONNECTION_TEST_PROMPT,
    }));
    setSaved(false);
  };

  const testConnection = async () => {
    await saveSettings(settings);
    setTestState("testing");
    setTestMessage("");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "AI_REQUEST",
        payload: {
          system: "",
          purpose: "chat",
          messages: [{ role: "user", content: settings.connectionTestPrompt }],
          temperature: 0,
        },
      }) as AiResponse;
      if (!response.ok) throw new Error(response.error || "连接失败");
      setTestState("ok");
      setTestMessage(response.content || "连接成功");
    } catch (cause) {
      setTestState("error");
      setTestMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const copyBridgeInstallCommand = async () => {
    await navigator.clipboard.writeText(BRIDGE_INSTALL_COMMAND);
    setBridgeCommandCopied(true);
    window.setTimeout(() => setBridgeCommandCopied(false), 1800);
  };

  if (!loaded) return <div className="options-loading"><LoaderCircle className="spin" /> 正在读取设置</div>;

  return (
    <main className="options-page">
      <header className="options-header">
        <div className="options-brand"><span><img src={chrome.runtime.getURL("icons/icon-32.png")} alt="" /></span>Lumen Paper</div>
        <div>
          <h1>让 AI 待在阅读的边缘。</h1>
          <p>密钥只保存在 Chrome 本地；Codex 模式只连接你电脑上的 bridge。</p>
        </div>
      </header>

      <section className="settings-card">
        <div className="section-heading">
          <span className="step">01</span>
          <div><h2>选择推理入口</h2><p>同一套阅读体验，后端可以自由替换。</p></div>
        </div>
        <div className="provider-grid">
          <ProviderCard
            active={settings.provider === "compatible"}
            icon={<KeyRound size={20} />}
            title="自定义 API"
            description="OpenAI-compatible Chat Completions；支持 OpenAI、OpenRouter、Ollama 或内部网关。"
            badge="通用"
            onClick={() => patch("provider", "compatible")}
          />
          <ProviderCard
            active={settings.provider === "codex"}
            icon={<Terminal size={20} />}
            title="Codex Plan"
            description="通过本机 Codex CLI 使用现有 ChatGPT 登录；扩展不读取账号 token。"
            badge="本机"
            onClick={() => patch("provider", "codex")}
          />
        </div>

        {settings.provider === "compatible" ? (
          <div className="field-grid provider-fields">
            <Field label="Chat Completions endpoint" span>
              <input value={settings.endpoint} onChange={(event) => patch("endpoint", event.target.value)} placeholder="https://api.openai.com/v1/chat/completions" />
            </Field>
            <Field label="API key" span>
              <div className="secret-field">
                <input type={showKey ? "text" : "password"} value={settings.apiKey} onChange={(event) => patch("apiKey", event.target.value)} placeholder="sk-…" />
                <button onClick={() => setShowKey((value) => !value)} aria-label="显示或隐藏密钥">{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              </div>
            </Field>
            <Field label="论文解读 / 总结模型">
              <ModelPicker
                value={settings.summaryModel}
                placeholder="例如 gpt-5.4-mini"
                models={catalog.provider === "compatible" ? catalog.models : []}
                state={catalog.provider === "compatible" ? catalog.state : "idle"}
                error={catalog.provider === "compatible" ? catalog.error : ""}
                onChange={(value) => patch("summaryModel", value)}
                onOpen={() => void loadModels()}
                onRefresh={() => void loadModels(true)}
              />
            </Field>
            <Field label="交流 / 划线问答模型">
              <ModelPicker
                value={settings.chatModel}
                placeholder="例如 gpt-5.4-mini"
                models={catalog.provider === "compatible" ? catalog.models : []}
                state={catalog.provider === "compatible" ? catalog.state : "idle"}
                error={catalog.provider === "compatible" ? catalog.error : ""}
                onChange={(value) => patch("chatModel", value)}
                onOpen={() => void loadModels()}
                onRefresh={() => void loadModels(true)}
              />
            </Field>
            <p className="model-guidance">点击模型框会从 API 的 <code>/models</code> 自动读取；不支持列表接口时仍可手动输入。</p>
          </div>
        ) : (
          <div className="codex-setup">
            <div className="terminal-instruction">
              <span>1</span>
              <div><b>确认 Codex 已登录 ChatGPT</b><code>codex login status</code></div>
            </div>
            <div className="terminal-instruction">
              <span>2</span>
              <div>
                <b>安装或更新 Bridge</b>
                <div className="bridge-install-command">
                  <code>{BRIDGE_INSTALL_COMMAND}</code>
                  <button type="button" onClick={() => void copyBridgeInstallCommand()}>
                    {bridgeCommandCopied ? <Check size={13} /> : <Copy size={13} />}
                    {bridgeCommandCopied ? "已复制" : "复制"}
                  </button>
                </div>
                <small>无需 git clone、npm install 或 sudo；安装后启动单一后台服务，并立即返回终端。</small>
              </div>
            </div>
            <div className="terminal-instruction">
              <span>3</span>
              <div>
                <b>把 pairing token 粘贴到下方</b>
                <code>~/.local/bin/lumen-paper-bridge pair</code>
                <small>安装时会自动复制；之后可用这条命令再次复制。</small>
              </div>
            </div>
            <div className="bridge-service">
              <span><strong>Bridge 后台服务</strong><small>Reader、Agent 和 Full Agent 共用同一个进程。</small></span>
              <code>~/.local/bin/lumen-paper-bridge start</code>
            </div>
            <div className="field-grid">
              <Field label="Bridge URL">
                <input value={settings.bridgeUrl} onChange={(event) => patch("bridgeUrl", event.target.value)} placeholder="http://127.0.0.1:43177" />
              </Field>
              <Field label="Pairing token">
                <input type="password" value={settings.bridgeToken} onChange={(event) => patch("bridgeToken", event.target.value)} placeholder="粘贴 bridge token" />
              </Field>
              <Field label="论文解读 / 总结模型">
                <ModelPicker
                  value={settings.codexSummaryModel}
                  placeholder="留空使用 Codex 默认模型"
                  models={catalog.provider === "codex" ? catalog.models : []}
                  state={catalog.provider === "codex" ? catalog.state : "idle"}
                  error={catalog.provider === "codex" ? catalog.error : ""}
                  allowDefault
                  onChange={(value) => patch("codexSummaryModel", value)}
                  onOpen={() => void loadModels()}
                  onRefresh={() => void loadModels(true)}
                />
              </Field>
              <Field label="交流 / 划线问答模型">
                <ModelPicker
                  value={settings.codexChatModel}
                  placeholder="留空使用 Codex 默认模型"
                  models={catalog.provider === "codex" ? catalog.models : []}
                  state={catalog.provider === "codex" ? catalog.state : "idle"}
                  error={catalog.provider === "codex" ? catalog.error : ""}
                  allowDefault
                  onChange={(value) => patch("codexChatModel", value)}
                  onOpen={() => void loadModels()}
                  onRefresh={() => void loadModels(true)}
                />
              </Field>
              <p className="model-guidance dark">点击模型框会读取当前 ChatGPT/Codex 账号实际可用的模型；留空会跟随 Codex 默认。</p>
            </div>
            <div className="permission-heading">
              <strong>交流 / 划线的 Codex 权限</strong>
              <small>选择并保存后立即生效，无需重启 Bridge。</small>
            </div>
            <div className="permission-grid">
              <PermissionCard
                active={settings.codexPermissionMode === "reader"}
                title="Reader"
                badge="read-only"
                description="空临时目录；忽略用户 config/rules。仍可 Web search 与只读命令。"
                onClick={() => patch("codexPermissionMode", "reader")}
              />
              <PermissionCard
                active={settings.codexPermissionMode === "agent"}
                title="Agent"
                badge="workspace-write"
                description="加载 Codex config、rules、skills 与 MCP；以 workspace-write 使用下方目录。"
                onClick={() => patch("codexPermissionMode", "agent")}
              />
              <PermissionCard
                active={settings.codexPermissionMode === "unrestricted"}
                disabled={!fullAccessConfirmed}
                danger
                title="Full Agent"
                badge="no sandbox"
                description="无审批、无 sandbox；可执行 shell、读写文件并触发外部工具副作用。"
                onClick={() => patch("codexPermissionMode", "unrestricted")}
              />
            </div>
            {settings.codexPermissionMode !== "reader" && (
              <div className="codex-workspace">
                <label className="field">
                  <span>Agent workspace（绝对路径）</span>
                  <input
                    value={settings.codexWorkspace}
                    onChange={(event) => patch("codexWorkspace", event.target.value)}
                    placeholder="/Users/you/path/to/workspace"
                    aria-invalid={Boolean(settings.codexWorkspace) && !settings.codexWorkspace.trim().startsWith("/")}
                  />
                </label>
                <small>Agent 将它作为 workspace-write 边界；Full Agent 只把它作为起始目录，仍可访问其他位置。Reader 和自动 Paper Brief 不会使用它。</small>
              </div>
            )}
            <label className="danger-confirm">
              <input
                type="checkbox"
                checked={fullAccessConfirmed}
                onChange={(event) => {
                  setFullAccessConfirmed(event.target.checked);
                  if (!event.target.checked && settings.codexPermissionMode === "unrestricted") {
                    patch("codexPermissionMode", "reader");
                  }
                }}
              />
              <span>我理解：恶意 PDF 或网页 prompt injection 可能在 Full Agent 中读写本机数据。</span>
            </label>
            <div className="codex-tool-list">
              <Toggle
                checked={settings.codexWebSearch}
                title="允许 Codex 使用 Web search"
                description="需要外部背景、相关工作或最新信息时可主动搜索；搜索结果按不可信外部内容处理。"
                onChange={(value) => patch("codexWebSearch", value)}
              />
              <Toggle
                checked={settings.codexCalculations}
                title="允许 Codex 做计算验证"
                description="这是完全可见的 runtime prompt 约束；真正文件与命令边界由上方权限模式决定。"
                onChange={(value) => patch("codexCalculations", value)}
              />
            </div>
            <div className="codex-boundary"><CircleAlert size={15} /> ChatGPT subscription 不能直接当普通 API key 使用。权限在页面逐次请求；自动 Paper Brief 始终固定为 Reader，也不会携带 workspace。</div>
          </div>
        )}
      </section>

      <section className="settings-card">
        <div className="section-heading">
          <span className="step">02</span>
          <div><h2>阅读行为</h2><p>默认自动，但不打断。</p></div>
        </div>
        <div className="toggle-list">
          <Toggle
            checked={settings.autoOpenPdfs}
            title="打开 PDF 时自动进入 Lumen"
            description="Chrome 150 使用兼容拦截；Chrome 151+ 使用原生 MIME handler。"
            onChange={(value) => patch("autoOpenPdfs", value)}
          />
          <Toggle
            checked={settings.autoAnalyze}
            title="打开后自动生成 Paper Brief"
            description="只发送摘要需要的页段；已有解读会直接从本地恢复。"
            onChange={(value) => patch("autoAnalyze", value)}
          />
          <Toggle
            checked={settings.storeConversations}
            title="在本地保存对话"
            description="按论文分开存储，便于下次继续；关闭后未来版本将支持临时会话。"
            onChange={(value) => patch("storeConversations", value)}
          />
        </div>
        <Field label="AI 回答语言">
          <select value={settings.responseLanguage} onChange={(event) => patch("responseLanguage", event.target.value as LumenSettings["responseLanguage"])}>
            <option value="zh-CN">中文（技术术语保留英文）</option>
            <option value="en">English</option>
            <option value="auto">跟随提问</option>
          </select>
        </Field>
        <Field label="默认交流语境">
          <select value={settings.chatMode} onChange={(event) => patch("chatMode", event.target.value as LumenSettings["chatMode"])}>
            <option value="research">研究模式：论文只是可选上下文</option>
            <option value="paper">论文模式：优先原文 grounding</option>
          </select>
        </Field>
      </section>

      <section className="settings-card">
        <div className="section-heading">
          <span className="step">03</span>
          <div><h2>Prompt Studio</h2><p>Lumen 与 Bridge 添加的全部自然语言 prompt 都在这里，没有隐藏的论文模式约束。</p></div>
        </div>
        <div className="prompt-studio-note">
          <CircleAlert size={15} />
          <span>这里能查看和修改的是 Lumen/Bridge 注入的完整 prompt。OpenAI/Codex 服务内部的 system/developer instructions 无法由扩展读取或覆盖。</span>
          <button type="button" onClick={resetPrompts}><RotateCcw size={13} /> 全部恢复默认</button>
        </div>
        <PromptEditor
          title="论文模式 · System prompt"
          description="Paper Brief、划线动作，以及“论文”对话模式使用。"
          value={settings.paperSystemPrompt}
          defaultValue={DEFAULT_PAPER_SYSTEM_PROMPT}
          onChange={(value) => patch("paperSystemPrompt", value)}
        />
        <PromptEditor
          title="研究模式 · System prompt"
          description="默认交流模式。论文只是可选 source，可使用模型知识、Web search 与工具。"
          value={settings.researchSystemPrompt}
          defaultValue={DEFAULT_RESEARCH_SYSTEM_PROMPT}
          onChange={(value) => patch("researchSystemPrompt", value)}
        />
        <PromptEditor
          title="Paper Brief · 阅读偏好"
          description="变量 {{summary_instructions}} 会把这段原样插入完整 Brief template。"
          value={settings.summaryPrompt}
          defaultValue={DEFAULT_SUMMARY_INSTRUCTIONS}
          onChange={(value) => patch("summaryPrompt", value)}
        />
        <PromptEditor
          title="Paper Brief · 完整 User template"
          description="可用变量：{{language}}、{{summary_instructions}}、{{paper_pages}}。删掉 JSON schema 后，解读卡片可能无法解析。"
          value={settings.summaryTemplate}
          defaultValue={DEFAULT_SUMMARY_TEMPLATE}
          onChange={(value) => patch("summaryTemplate", value)}
        />
        <PromptEditor
          title="普通交流 · User template"
          description="可用变量：{{question}}、{{paper_pages}}。研究模式只在问题与论文相关时附页段。"
          value={settings.chatTemplate}
          defaultValue={DEFAULT_CHAT_TEMPLATE}
          onChange={(value) => patch("chatTemplate", value)}
        />
        <PromptEditor
          title="划线 · 解释 template"
          description="可用变量：{{selection}}、{{page}}、{{page_context}}。"
          value={settings.explainTemplate}
          defaultValue={DEFAULT_EXPLAIN_TEMPLATE}
          onChange={(value) => patch("explainTemplate", value)}
        />
        <PromptEditor
          title="划线 · 翻译 template"
          description="可用变量：{{selection}}、{{page}}、{{page_context}}。"
          value={settings.translateTemplate}
          defaultValue={DEFAULT_TRANSLATE_TEMPLATE}
          onChange={(value) => patch("translateTemplate", value)}
        />
        <PromptEditor
          title="划线 · Reviewer challenge template"
          description="可用变量：{{selection}}、{{page}}、{{page_context}}。"
          value={settings.challengeTemplate}
          defaultValue={DEFAULT_CHALLENGE_TEMPLATE}
          onChange={(value) => patch("challengeTemplate", value)}
        />
        <PromptEditor
          title="Codex runtime prompt"
          description="Bridge 会把它接在所选 system prompt 后；可用变量：{{web_search_status}}、{{command_status}}。Bridge 不再追加其他自然语言限制。"
          value={settings.codexRuntimePrompt}
          defaultValue={DEFAULT_CODEX_RUNTIME_PROMPT}
          onChange={(value) => patch("codexRuntimePrompt", value)}
        />
        <PromptEditor
          title="连接测试 prompt"
          description="只在点击“测试连接”时发送。"
          value={settings.connectionTestPrompt}
          defaultValue={DEFAULT_CONNECTION_TEST_PROMPT}
          onChange={(value) => patch("connectionTestPrompt", value)}
        />
      </section>

      <footer className="options-footer">
        <button className="test-button" onClick={() => void testConnection()} disabled={testState === "testing"}>
          {testState === "testing" ? <LoaderCircle className="spin" size={16} /> : <Code2 size={16} />}
          测试连接
        </button>
        {testState !== "idle" && testState !== "testing" && (
          <div className={`test-result ${testState}`}>
            {testState === "ok" ? <Check size={15} /> : <CircleAlert size={15} />}{testMessage}
          </div>
        )}
        <button className="save-button" onClick={() => void persist()}><Save size={16} /> {saved ? "已保存" : "保存设置"}</button>
      </footer>
    </main>
  );
}

function ProviderCard({ active, icon, title, description, badge, onClick }: {
  active: boolean; icon: React.ReactNode; title: string; description: string; badge: string; onClick: () => void;
}) {
  return (
    <button className={`provider-card ${active ? "active" : ""}`} onClick={onClick}>
      <span className="provider-icon">{icon}</span>
      <span className="provider-copy"><strong>{title}</strong><small>{description}</small></span>
      <span className="provider-badge">{badge}</span>
      <ChevronRight className="provider-chevron" size={16} />
    </button>
  );
}

function PermissionCard({ active, disabled = false, danger = false, title, badge, description, onClick }: {
  active: boolean;
  disabled?: boolean;
  danger?: boolean;
  title: string;
  badge: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`permission-card ${active ? "active" : ""} ${danger ? "danger" : ""}`}
      onClick={onClick}
    >
      <span><strong>{title}</strong><em>{badge}</em></span>
      <small>{description}</small>
    </button>
  );
}

function PromptEditor({ title, description, value, defaultValue, onChange }: {
  title: string;
  description: string;
  value: string;
  defaultValue: string;
  onChange: (value: string) => void;
}) {
  return (
    <details className="prompt-editor">
      <summary>
        <span><strong>{title}</strong><small>{description}</small></span>
        <ChevronDown size={15} />
      </summary>
      <div>
        <div className="prompt-editor-actions">
          <span>{value.length.toLocaleString()} chars</span>
          <button type="button" disabled={value === defaultValue} onClick={() => onChange(defaultValue)}>
            <RotateCcw size={12} /> 恢复默认
          </button>
        </div>
        <textarea rows={10} value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
      </div>
    </details>
  );
}

function Field({ label, span = false, children }: { label: string; span?: boolean; children: React.ReactNode }) {
  return <label className={`field ${span ? "span" : ""}`}><span>{label}</span>{children}</label>;
}

function ModelPicker({ value, placeholder, models, state, error, allowDefault = false, onChange, onOpen, onRefresh }: {
  value: string;
  placeholder: string;
  models: ModelOption[];
  state: CatalogState;
  error: string;
  allowDefault?: boolean;
  onChange: (value: string) => void;
  onOpen: () => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const query = filterText.trim().toLowerCase();
  const filtered = models.filter((model) => {
    if (!query) return true;
    return `${model.id} ${model.name || ""} ${model.description || ""}`.toLowerCase().includes(query);
  });

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const show = () => {
    setOpen(true);
    setFilterText("");
    onOpen();
  };

  return (
    <div className="model-picker" ref={rootRef}>
      <input
        value={value}
        placeholder={placeholder}
        onFocus={show}
        onClick={show}
        onChange={(event) => {
          onChange(event.target.value);
          setFilterText(event.target.value);
          setOpen(true);
        }}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
      />
      <button type="button" className="model-picker-trigger" onClick={show} aria-label="显示可选模型">
        {state === "loading" ? <LoaderCircle className="spin" size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="model-menu" role="listbox">
          <div className="model-menu-heading">
            <span>{state === "loading" ? "正在读取可用模型…" : `${models.length} 个可选模型`}</span>
            <button type="button" onClick={onRefresh} title="重新读取"><RefreshCw size={12} /></button>
          </div>
          {state === "error" && (
            <div className="model-menu-message error"><CircleAlert size={13} /><span>{error}<small>仍可在上方手动输入模型名称。</small></span></div>
          )}
          {state === "loading" && <div className="model-menu-message"><LoaderCircle className="spin" size={14} /> 正在连接…</div>}
          {allowDefault && state !== "loading" && (
            <button type="button" className={`model-option ${value === "" ? "selected" : ""}`} onClick={() => { onChange(""); setFilterText(""); setOpen(false); }}>
              <span><strong>Codex 当前默认模型</strong><small>自动跟随账号默认与后续升级</small></span>
              {value === "" && <Check size={14} />}
            </button>
          )}
          {state === "ok" && filtered.map((model) => (
            <button type="button" className={`model-option ${value === model.id ? "selected" : ""}`} key={model.id} onClick={() => { onChange(model.id); setFilterText(""); setOpen(false); }}>
              <span><strong>{model.name || model.id}{model.isDefault ? <em>默认</em> : null}</strong><code>{model.id}</code>{model.description && <small>{model.description}</small>}</span>
              {value === model.id && <Check size={14} />}
            </button>
          ))}
          {state === "ok" && !filtered.length && <div className="model-menu-message">没有匹配项，可继续手动输入。</div>}
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, title, description, onChange }: { checked: boolean; title: string; description: string; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span><strong>{title}</strong><small>{description}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i />
    </label>
  );
}

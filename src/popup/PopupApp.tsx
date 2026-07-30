import { ArrowUpRight, FileText, Settings, Sparkles, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { getSettings, settingsAreReady } from "../lib/storage";

export function PopupApp() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);

  useEffect(() => {
    void Promise.all([
      getSettings(),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]).then(([settings, tabs]) => {
      setReady(settingsAreReady(settings));
      setTab(tabs[0] ?? null);
    });
  }, []);

  const openReader = async (useCurrent = false) => {
    const query = new URLSearchParams();
    if (useCurrent && tab?.url && /^(https?|file):/i.test(tab.url)) query.set("source", tab.url);
    const url = chrome.runtime.getURL(`viewer.html?${query.toString()}`);
    if (tab?.id != null) await chrome.tabs.update(tab.id, { url });
    else await chrome.tabs.create({ url });
    window.close();
  };

  return (
    <main className="popup">
      <header><span><FileText size={15} /></span><strong>Lumen Paper</strong><i className={ready ? "ready" : ""}>{ready ? "AI ready" : "setup"}</i></header>
      <div className="popup-hero"><Sparkles size={18} /><p>读论文，不离开论文。</p></div>
      <button className="popup-primary" onClick={() => void openReader(true)}><ArrowUpRight size={16} /> 用 Lumen 打开当前页</button>
      <button onClick={() => void openReader(false)}><Upload size={15} /> 选择本机 PDF</button>
      <button onClick={() => chrome.runtime.openOptionsPage()}><Settings size={15} /> {ready ? "阅读与模型设置" : "配置 AI 入口"}</button>
      <footer>划线后可直接解释、翻译、质疑。</footer>
    </main>
  );
}

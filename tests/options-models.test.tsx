/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/lib/storage";
import { OptionsApp } from "../src/options/OptionsApp";
import type { ModelListResponse } from "../src/types";

describe("Codex model discovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sendMessage = vi.fn();
    const stored = {
      ...DEFAULT_SETTINGS,
      provider: "codex" as const,
      bridgeToken: "paired-token",
    };
    globalThis.chrome = {
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage,
      },
      storage: {
        local: {
          get: vi.fn(async () => ({ [SETTINGS_KEY]: stored })),
          set: vi.fn(async () => undefined),
        },
      },
    } as unknown as typeof chrome;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("replaces a settled Origin error after a successful connection test", async () => {
    let modelRequestCount = 0;
    sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "AI_REQUEST") return { ok: true, content: "连接成功" };
      if (message.type === "BRIDGE_STATUS") {
        return { ok: true, bridge: { version: "0.1.21", protocolVersion: 2 } };
      }
      if (message.type === "LIST_MODELS") {
        modelRequestCount += 1;
        return modelRequestCount === 1
          ? { ok: false, error: "Origin denied" }
          : { ok: true, models: [{ id: "gpt-5", name: "GPT-5" }] };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    });

    await renderOptions();
    await openSummaryModels();
    expect(container.textContent).toContain("Origin denied");

    await testConnection();
    expect(modelRequestCount).toBe(2);
    expect(container.textContent).not.toContain("Origin denied");
    expect(container.textContent).toContain("GPT-5");
    expect(container.textContent).toContain("Bridge v0.1.21");
  });

  it("ignores an old model error that resolves after a successful refresh", async () => {
    let resolveOldRequest: ((value: ModelListResponse) => void) | undefined;
    const oldRequest = new Promise<ModelListResponse>((resolve) => { resolveOldRequest = resolve; });
    let modelRequestCount = 0;
    sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "AI_REQUEST") return { ok: true, content: "连接成功" };
      if (message.type === "BRIDGE_STATUS") {
        return { ok: true, bridge: { version: "0.1.21", protocolVersion: 2 } };
      }
      if (message.type === "LIST_MODELS") {
        modelRequestCount += 1;
        if (modelRequestCount === 1) return oldRequest;
        return {
          ok: true,
          models: [{ id: "gpt-5", name: "GPT-5" }],
        };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    });

    await renderOptions();
    await openSummaryModels();
    expect(modelRequestCount).toBe(1);

    await testConnection();

    expect(modelRequestCount).toBe(2);
    expect(container.textContent).toContain("GPT-5");
    expect(container.textContent).toContain("Bridge v0.1.21");

    await act(async () => {
      resolveOldRequest?.({ ok: false, error: "Origin denied" });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Origin denied");
    expect(container.textContent).toContain("GPT-5");
  });

  it("deduplicates bridge status reads when focus and click open the same picker", async () => {
    sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "BRIDGE_STATUS") {
        await Promise.resolve();
        return { ok: true, bridge: { version: "0.1.21", protocolVersion: 2 } };
      }
      if (message.type === "LIST_MODELS") return { ok: true, models: [{ id: "gpt-5" }] };
      throw new Error(`Unexpected message: ${message.type}`);
    });

    await renderOptions();
    const summaryModel = fieldInput("论文解读 / 总结模型");
    await act(async () => {
      summaryModel.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      summaryModel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendMessage.mock.calls.filter(([message]) => message.type === "BRIDGE_STATUS")).toHaveLength(1);
  });

  it("keeps model discovery usable when auxiliary Bridge status lookup rejects", async () => {
    sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === "BRIDGE_STATUS") throw new Error("worker restarted");
      if (message.type === "LIST_MODELS") return { ok: true, models: [{ id: "gpt-5", name: "GPT-5" }] };
      throw new Error(`Unexpected message: ${message.type}`);
    });

    await renderOptions();
    await openSummaryModels();
    expect(container.textContent).toContain("GPT-5");
    expect(container.textContent).not.toContain("worker restarted");
  });

  async function renderOptions() {
    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function openSummaryModels() {
    const summaryModel = fieldInput("论文解读 / 总结模型");
    await act(async () => {
      summaryModel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function testConnection() {
    const testButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("测试连接"));
    expect(testButton).toBeDefined();
    await act(async () => {
      testButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function fieldInput(labelText: string): HTMLInputElement {
    const label = [...container.querySelectorAll("label")].find(
      (candidate) => candidate.firstElementChild?.textContent === labelText,
    );
    const input = label?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input for ${labelText}`);
    return input;
  }
});

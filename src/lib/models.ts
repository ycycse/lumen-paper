import type { ModelOption } from "../types";

export function modelsEndpoint(chatEndpoint: string): string {
  const url = new URL(chatEndpoint.trim());
  const pathname = url.pathname.replace(/\/+$/, "");
  const knownSuffix = /\/(?:chat\/completions|responses)$/;
  url.pathname = knownSuffix.test(pathname)
    ? pathname.replace(knownSuffix, "/models")
    : `${pathname}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function normalizeModelOptions(payload: unknown): ModelOption[] {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const source = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const model = item as Record<string, unknown>;
    const id = [model.id, model.model, model.name].find((value) => typeof value === "string" && value.trim());
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      name: typeof model.displayName === "string"
        ? model.displayName
        : typeof model.name === "string" && model.name !== id ? model.name : undefined,
      description: typeof model.description === "string" ? model.description : undefined,
      isDefault: model.isDefault === true,
    });
    if (options.length >= 300) break;
  }
  return options.sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.id.localeCompare(right.id));
}

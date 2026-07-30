export function sourceFaviconUrl(
  candidate: string | undefined | null,
  sourceUrl: string | undefined | null,
  candidatePageUrl?: string | null,
): string {
  const source = parseHttpUrl(sourceUrl);
  if (!source) return "";

  const icon = parseHttpUrl(candidate);
  const candidatePage = parseHttpUrl(candidatePageUrl);
  const candidateBelongsToSource = !candidatePage || candidatePage.origin === source.origin;
  if (icon && candidateBelongsToSource) return icon.href;

  return new URL("/favicon.ico", source).href;
}

function parseHttpUrl(value: string | undefined | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

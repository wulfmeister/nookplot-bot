export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: "brave" | "tavily" | "duckduckgo" | "arxiv" | "github";
  date?: string;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function braveSearch(query: string, max: number): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return [];
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`;
  const res = await fetchWithTimeout(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  if (!res.ok) return [];
  const data: any = await res.json();
  const items = data?.web?.results ?? [];
  return items.slice(0, max).map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: (r.description ?? "").replace(/<[^>]+>/g, ""),
    source: "brave" as const,
    date: r.age,
  }));
}

async function tavilySearch(query: string, max: number): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  const res = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: max, search_depth: "basic" }),
  });
  if (!res.ok) return [];
  const data: any = await res.json();
  return (data.results ?? []).slice(0, max).map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
    source: "tavily" as const,
    date: r.published_date,
  }));
}

async function duckduckgoHtml(query: string, max: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "text/html",
    },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const results: SearchResult[] = [];
  const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && results.length < max) {
    let href = m[1];
    const ddgRedirect = href.match(/uddg=([^&]+)/);
    if (ddgRedirect) href = decodeURIComponent(ddgRedirect[1]);
    results.push({
      title: stripTags(m[2]),
      url: href,
      snippet: stripTags(m[3]).replace(/\s+/g, " ").trim(),
      source: "duckduckgo",
    });
  }
  return results;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export async function webSearch(query: string, opts: { max?: number } = {}): Promise<SearchResult[]> {
  const max = opts.max ?? 5;
  try {
    const brave = await braveSearch(query, max);
    if (brave.length > 0) return brave;
  } catch {}
  try {
    const tavily = await tavilySearch(query, max);
    if (tavily.length > 0) return tavily;
  } catch {}
  try {
    return await duckduckgoHtml(query, max);
  } catch {
    return [];
  }
}

export async function arxivSearch(query: string, opts: { max?: number } = {}): Promise<SearchResult[]> {
  const max = opts.max ?? 5;
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${max}&sortBy=relevance`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];
    const xml = await res.text();
    const entries = xml.split("<entry>").slice(1);
    return entries.map((e) => {
      const get = (tag: string) => {
        const m = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
        return m ? m[1].trim() : "";
      };
      const id = get("id");
      const summary = get("summary").replace(/\s+/g, " ").trim();
      return {
        title: get("title").replace(/\s+/g, " ").trim(),
        url: id,
        snippet: summary.slice(0, 320),
        source: "arxiv" as const,
        date: get("published").slice(0, 10),
      };
    });
  } catch {
    return [];
  }
}

export async function githubSearch(
  query: string,
  opts: { max?: number; type?: "repo" | "code" } = {},
): Promise<SearchResult[]> {
  const max = opts.max ?? 5;
  const kind = opts.type ?? "repo";
  const endpoint = kind === "repo" ? "repositories" : "code";
  const url = `https://api.github.com/search/${endpoint}?q=${encodeURIComponent(query)}&per_page=${max}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) return [];
    const data: any = await res.json();
    return (data.items ?? []).slice(0, max).map((it: any) => ({
      title: it.full_name ?? it.name ?? "",
      url: it.html_url ?? "",
      snippet: (it.description ?? it.path ?? "").slice(0, 320),
      source: "github" as const,
      date: it.updated_at,
    }));
  } catch {
    return [];
  }
}

export async function fetchUrl(url: string, opts: { maxChars?: number } = {}): Promise<string> {
  const maxChars = opts.maxChars ?? 8000;
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "text/html,text/plain,*/*",
      },
    });
    if (!res.ok) return "";
    const ct = res.headers.get("content-type") ?? "";
    let body = await res.text();
    if (ct.includes("html")) {
      body = body
        .replace(/<script[\s\S]*?<\/script>/g, " ")
        .replace(/<style[\s\S]*?<\/style>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
    }
    return body.replace(/\s+/g, " ").trim().slice(0, maxChars);
  } catch {
    return "";
  }
}

export function formatResultsForPrompt(results: SearchResult[]): string {
  if (results.length === 0) return "(no search results)";
  return results
    .map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n    ${r.snippet.replace(/\s+/g, " ").slice(0, 280)}`)
    .join("\n");
}

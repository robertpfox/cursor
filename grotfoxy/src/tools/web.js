import { settings } from '../db/index.js';
import { decryptSecret } from '../core/crypto.js';

function hostAllowed(url, allowedHosts) {
  if (!allowedHosts?.length) return true;
  const { hostname } = new URL(url);
  return allowedHosts.some((entry) => {
    const pattern = String(entry).trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith('*.')) return hostname.endsWith(pattern.slice(1));
    return hostname === pattern;
  });
}

/** Crude but dependency-free HTML-to-text. Good enough to feed a model. */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n\n[truncated]` : value;
}

/**
 * Keyless search via DuckDuckGo's HTML endpoint so a stock install can research
 * the web without another paid account. A Brave or Tavily key can be added in
 * Settings for better results.
 */
async function duckDuckGoSearch(query, signal) {
  const response = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (compatible; GrotFoxy/1.0)',
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  });
  if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
  const html = await response.text();

  const results = [];
  const linkPattern =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null && results.length < 10) {
    let url = match[1];
    const redirect = url.match(/uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    results.push({ url, title: htmlToText(match[2]) });
  }
  const snippetPattern = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let index = 0;
  while ((match = snippetPattern.exec(html)) !== null && index < results.length) {
    results[index].snippet = htmlToText(match[1]);
    index += 1;
  }
  return results;
}

async function braveSearch(query, apiKey, signal) {
  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`,
    { headers: { 'x-subscription-token': apiKey, accept: 'application/json' }, signal },
  );
  if (!response.ok) throw new Error(`Brave Search returned HTTP ${response.status}`);
  const data = await response.json();
  return (data?.web?.results ?? []).map((entry) => ({
    url: entry.url,
    title: entry.title,
    snippet: htmlToText(entry.description ?? ''),
  }));
}

export const webTools = [
  {
    name: 'web_search',
    group: 'web',
    sensitivity: 'safe',
    description: 'Search the web and return the top results with titles, URLs and snippets.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for.' } },
      required: ['query'],
    },
    async execute({ query }, ctx) {
      const braveKey = decryptSecret(settings.get('search.braveKeyEnc', ''));
      const results = braveKey
        ? await braveSearch(query, braveKey, ctx.signal)
        : await duckDuckGoSearch(query, ctx.signal);
      if (!results.length) return { output: `No results for "${query}".` };
      return {
        output: results
          .map((entry, i) => `${i + 1}. ${entry.title}\n   ${entry.url}\n   ${entry.snippet ?? ''}`)
          .join('\n\n'),
        meta: { count: results.length },
      };
    },
  },
  {
    name: 'fetch_page',
    group: 'web',
    sensitivity: 'safe',
    description: 'Fetch a web page and return its readable text content.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
        max_chars: { type: 'number', description: 'Maximum characters to return (default 15000).' },
      },
      required: ['url'],
    },
    async execute({ url, max_chars: maxChars = 15_000 }, ctx) {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported');
      if (!hostAllowed(url, ctx.bot.allowedHosts)) {
        throw new Error(`Host is not in this bot's allowed hosts list: ${new URL(url).hostname}`);
      }
      const response = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; GrotFoxy/1.0)' },
        signal: ctx.signal,
      });
      const body = await response.text();
      const contentType = response.headers.get('content-type') ?? '';
      const text = contentType.includes('html') ? htmlToText(body) : body;
      return {
        output: `HTTP ${response.status} ${url}\n\n${clip(text, Math.min(Number(maxChars) || 15_000, 60_000))}`,
      };
    },
  },
  {
    name: 'http_request',
    group: 'web',
    sensitivity: 'sensitive',
    description:
      'Make an arbitrary HTTP request (GET/POST/PUT/PATCH/DELETE) and return the status and body. Use for APIs.',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method. Defaults to GET.' },
        url: { type: 'string' },
        headers: { type: 'object', description: 'Header name/value pairs.', additionalProperties: { type: 'string' } },
        body: { type: 'string', description: 'Raw request body, usually JSON.' },
      },
      required: ['url'],
    },
    async execute({ method = 'GET', url, headers = {}, body }, ctx) {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported');
      if (!hostAllowed(url, ctx.bot.allowedHosts)) {
        throw new Error(`Host is not in this bot's allowed hosts list: ${new URL(url).hostname}`);
      }
      const response = await fetch(url, {
        method: String(method).toUpperCase(),
        headers: { 'user-agent': 'GrotFoxy/1.0', ...headers },
        body: ['GET', 'HEAD'].includes(String(method).toUpperCase()) ? undefined : body,
        signal: ctx.signal,
      });
      const text = await response.text();
      return {
        output: `HTTP ${response.status} ${response.statusText}\n\n${clip(text, 40_000)}`,
        meta: { status: response.status },
      };
    },
  },
];

export default webTools;

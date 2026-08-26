/**
 * Local cost table, in USD per 1M tokens. GrotFoxy never phones home to price a
 * run, so this is a best-effort estimate you can edit. Anything unmatched is
 * treated as free, which is correct for local Ollama / LM Studio models.
 */
const TABLE = [
  { match: /^gpt-5/i, in: 1.25, out: 10 },
  { match: /^gpt-4\.1-mini/i, in: 0.4, out: 1.6 },
  { match: /^gpt-4\.1-nano/i, in: 0.1, out: 0.4 },
  { match: /^gpt-4\.1/i, in: 2, out: 8 },
  { match: /^gpt-4o-mini/i, in: 0.15, out: 0.6 },
  { match: /^gpt-4o/i, in: 2.5, out: 10 },
  { match: /^o4-mini/i, in: 1.1, out: 4.4 },
  { match: /^o3/i, in: 2, out: 8 },
  { match: /claude.*haiku/i, in: 0.8, out: 4 },
  { match: /claude.*sonnet/i, in: 3, out: 15 },
  { match: /claude.*opus/i, in: 15, out: 75 },
  { match: /^grok.*mini/i, in: 0.3, out: 0.5 },
  { match: /^grok/i, in: 3, out: 15 },
  { match: /gemini.*flash/i, in: 0.3, out: 2.5 },
  { match: /gemini.*pro/i, in: 1.25, out: 10 },
  { match: /deepseek/i, in: 0.28, out: 0.42 },
];

export function priceFor(model) {
  const name = String(model || '');
  return TABLE.find((entry) => entry.match.test(name)) ?? { in: 0, out: 0 };
}

/** Local providers are free by definition; never bill them even for known model names. */
export function estimateCost({ model, kind, inputTokens = 0, outputTokens = 0 }) {
  if (kind === 'ollama' || kind === 'local') return 0;
  const price = priceFor(model);
  return (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out;
}

export default estimateCost;

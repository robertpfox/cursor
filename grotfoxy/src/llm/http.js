import log from '../core/logger.js';

export class LlmError extends Error {
  constructor(message, { status = 0, retryable = false, data = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
    this.data = data;
  }
}

const RETRY_DELAYS_MS = [1000, 3000, 8000];

function describe(status, text) {
  const trimmed = String(text || '').slice(0, 400);
  try {
    const parsed = JSON.parse(text);
    const detail = parsed?.error?.message || parsed?.message || parsed?.error;
    if (detail) return `HTTP ${status}: ${detail}`;
  } catch {
    /* body was not JSON; fall back to the raw text below */
  }
  return `HTTP ${status}${trimmed ? `: ${trimmed}` : ''}`;
}

/**
 * POST/GET JSON with the retry policy model APIs actually need: back off on
 * rate limits and transient server errors, fail fast on anything the caller
 * must fix (bad key, bad model name, malformed request).
 */
export async function requestJson(url, options = {}, { retries = RETRY_DELAYS_MS.length } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('Request cancelled', { retryable: false });
      const code = connectionErrorCode(error);
      // Nothing is listening, or the name does not resolve. Retrying just makes
      // the owner wait longer to be told their model server is down.
      if (code) {
        throw new LlmError(
          `Cannot reach the model endpoint at ${url} (${code}). Is the provider URL right, and is the server running?`,
          { retryable: false },
        );
      }
      lastError = new LlmError(`Network error contacting ${url}: ${error.message}`, {
        retryable: true,
      });
      await delay(attempt, options.signal);
      continue;
    }

    if (response.ok) {
      const text = await response.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new LlmError('Model endpoint returned a non-JSON body', {
          status: response.status,
          retryable: false,
          data: text.slice(0, 400),
        });
      }
    }

    const text = await response.text().catch(() => '');
    const retryable = response.status === 429 || response.status >= 500;
    lastError = new LlmError(describe(response.status, text), {
      status: response.status,
      retryable,
      data: text.slice(0, 2000),
    });
    if (!retryable) throw lastError;
    log.warn(`model request ${response.status}, retrying (attempt ${attempt + 1})`);
    await delay(attempt, options.signal);
  }
  throw lastError ?? new LlmError('Model request failed');
}

const HARD_CONNECTION_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN']);

/**
 * Digs the real socket error out of a `fetch` failure. undici nests it under
 * `cause`, and when a host resolves to both IPv4 and IPv6 it nests an
 * AggregateError with one entry per attempt.
 */
function connectionErrorCode(error) {
  const seen = new Set();
  const queue = [error];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (HARD_CONNECTION_ERRORS.has(current.code)) return current.code;
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors);
  }
  return null;
}

function delay(attempt, signal) {
  const ms = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new LlmError('Request cancelled', { retryable: false }));
      },
      { once: true },
    );
  });
}

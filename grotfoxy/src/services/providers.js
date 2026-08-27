import { all, get, now, run } from '../db/index.js';
import { decryptSecret, encryptSecret, newId } from '../core/crypto.js';
import { listModels } from '../llm/index.js';

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    enabled: Boolean(row.enabled),
    hasKey: Boolean(row.api_key_enc),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Internal form including the decrypted key. Never send this to the browser. */
export function resolveProvider(id) {
  const row = get('SELECT * FROM providers WHERE id = ?', id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    apiKey: decryptSecret(row.api_key_enc),
    defaultModel: row.default_model,
    enabled: Boolean(row.enabled),
  };
}

export function listProviders() {
  return all('SELECT * FROM providers ORDER BY created_at').map(toPublic);
}

export function getProvider(id) {
  return toPublic(get('SELECT * FROM providers WHERE id = ?', id));
}

export function firstEnabledProvider() {
  const row = get('SELECT * FROM providers WHERE enabled = 1 ORDER BY created_at LIMIT 1');
  return row ? resolveProvider(row.id) : null;
}

export function createProvider(input) {
  const id = newId('prv');
  const timestamp = now();
  run(
    `INSERT INTO providers (id, name, kind, base_url, api_key_enc, default_model, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name?.trim() || 'Provider',
    input.kind || 'openai',
    input.baseUrl?.trim() || '',
    encryptSecret(input.apiKey || ''),
    input.defaultModel?.trim() || '',
    input.enabled === false ? 0 : 1,
    timestamp,
    timestamp,
  );
  return getProvider(id);
}

export function updateProvider(id, input) {
  const existing = get('SELECT * FROM providers WHERE id = ?', id);
  if (!existing) return null;
  // An empty apiKey means "leave it alone"; the UI never round-trips the secret.
  const apiKeyEnc =
    input.apiKey === undefined || input.apiKey === ''
      ? existing.api_key_enc
      : encryptSecret(input.apiKey);
  run(
    `UPDATE providers SET name = ?, kind = ?, base_url = ?, api_key_enc = ?, default_model = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
    input.name?.trim() || existing.name,
    input.kind || existing.kind,
    input.baseUrl === undefined ? existing.base_url : input.baseUrl.trim(),
    apiKeyEnc,
    input.defaultModel === undefined ? existing.default_model : input.defaultModel.trim(),
    input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
    now(),
    id,
  );
  return getProvider(id);
}

export function deleteProvider(id) {
  run('DELETE FROM providers WHERE id = ?', id);
}

export function clearProviderKey(id) {
  run('UPDATE providers SET api_key_enc = ?, updated_at = ? WHERE id = ?', '', now(), id);
  return getProvider(id);
}

export async function testProvider(id) {
  const provider = resolveProvider(id);
  if (!provider) return { ok: false, error: 'Provider not found' };
  try {
    const models = await listModels({ provider });
    return { ok: true, models: models.slice(0, 200) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

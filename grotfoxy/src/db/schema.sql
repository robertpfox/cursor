-- GrotFoxy schema. Everything the instance knows lives in this one SQLite file,
-- which makes "back up your teammates" a single file copy on the host machine.

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL UNIQUE,
  user_agent   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_digest ON sessions(token_digest);

CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  token_hint   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

-- Model providers. GrotFoxy talks to whatever you point it at: a paid API with
-- your own key, or a local Ollama / LM Studio server for a zero-cost setup.
CREATE TABLE IF NOT EXISTS providers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  base_url      TEXT NOT NULL DEFAULT '',
  api_key_enc   TEXT NOT NULL DEFAULT '',
  default_model TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Connectors are MCP servers. This is how a bot reaches Gmail, Slack, GitHub,
-- the smart home, a trading terminal, or anything else with an MCP server.
CREATE TABLE IF NOT EXISTS connectors (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL DEFAULT '',
  transport    TEXT NOT NULL DEFAULT 'stdio',
  command      TEXT NOT NULL DEFAULT '',
  args         TEXT NOT NULL DEFAULT '[]',
  env          TEXT NOT NULL DEFAULT '{}',
  cwd          TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL DEFAULT '',
  headers_enc  TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_status  TEXT NOT NULL DEFAULT 'unknown',
  last_error   TEXT NOT NULL DEFAULT '',
  tool_cache   TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  emoji           TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT '#f97316',
  job             TEXT NOT NULL DEFAULT '',
  context         TEXT NOT NULL DEFAULT '',
  boundaries      TEXT NOT NULL DEFAULT '',
  provider_id     TEXT REFERENCES providers(id) ON DELETE SET NULL,
  model           TEXT NOT NULL DEFAULT '',
  temperature     REAL NOT NULL DEFAULT 0.2,
  tools           TEXT NOT NULL DEFAULT '[]',
  connectors      TEXT NOT NULL DEFAULT '[]',
  approval_policy TEXT NOT NULL DEFAULT 'sensitive',
  -- Off by default: small local models routinely emit a second tool call whose
  -- arguments depend on the first one's result, which produces placeholder junk.
  parallel_tools  INTEGER NOT NULL DEFAULT 0,
  max_steps       INTEGER NOT NULL DEFAULT 25,
  max_seconds     INTEGER NOT NULL DEFAULT 900,
  max_cost_usd    REAL NOT NULL DEFAULT 1.0,
  allowed_hosts   TEXT NOT NULL DEFAULT '[]',
  shell_allow     TEXT NOT NULL DEFAULT '[]',
  shell_deny      TEXT NOT NULL DEFAULT '[]',
  schedule_cron   TEXT NOT NULL DEFAULT '',
  schedule_task   TEXT NOT NULL DEFAULT '',
  schedule_on     INTEGER NOT NULL DEFAULT 0,
  next_run_at     TEXT,
  webhook_digest  TEXT NOT NULL DEFAULT '',
  webhook_on      INTEGER NOT NULL DEFAULT 0,
  notify_on       TEXT NOT NULL DEFAULT 'always',
  enabled         INTEGER NOT NULL DEFAULT 1,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bots_schedule ON bots(schedule_on, next_run_at);

CREATE TABLE IF NOT EXISTS threads (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_bot ON threads(bot_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  bot_id        TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  thread_id     TEXT REFERENCES threads(id) ON DELETE CASCADE,
  parent_run_id TEXT,
  trigger       TEXT NOT NULL DEFAULT 'manual',
  status        TEXT NOT NULL DEFAULT 'queued',
  task          TEXT NOT NULL DEFAULT '',
  result        TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  steps_used    INTEGER NOT NULL DEFAULT 0,
  -- Milliseconds actually spent working, excluding time parked on an approval.
  -- A run that waits overnight for a human must not burn its time budget doing so.
  active_ms     INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  model         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_bot ON runs(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, created_at);

-- Verbatim model transcript. Persisting it after every turn is what lets a run
-- survive a reboot of the host machine and resume where it paused.
CREATE TABLE IF NOT EXISTS run_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  tool_calls   TEXT NOT NULL DEFAULT '',
  tool_call_id TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_messages ON run_messages(run_id, seq);

-- Human-readable activity timeline shown in the UI (the audit view).
CREATE TABLE IF NOT EXISTS run_steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'done',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_steps ON run_steps(run_id, seq);

-- Approval gates and clarifying questions share one table: both are "the run
-- paused and needs a human", and both resume the same way.
CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  bot_id       TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'approval',
  tool_name    TEXT NOT NULL,
  tool_call_id TEXT NOT NULL DEFAULT '',
  args         TEXT NOT NULL DEFAULT '{}',
  reason       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',
  note         TEXT NOT NULL DEFAULT '',
  decided_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  decided_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_call ON approvals(run_id, tool_call_id);

CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, key)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL DEFAULT '',
  run_id     TEXT NOT NULL DEFAULT '',
  level      TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_daily (
  day        TEXT NOT NULL,
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  runs       INTEGER NOT NULL DEFAULT 0,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, model)
);

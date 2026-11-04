// SQLite store for the Agent API (partner keys, agents, owner intents, grants, operations). Lives next to the swap db in DATA_DIR.
import Database from 'better-sqlite3';
import path from 'node:path';
import { DIR } from '../store.mjs';

export const sql = new Database(path.join(DIR, 'agent-api.sqlite'));
sql.pragma('journal_mode = WAL');
sql.exec(`
CREATE TABLE IF NOT EXISTS partner_keys (
  id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, name TEXT, ip_hash TEXT, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, external_user_id TEXT, status TEXT NOT NULL,
  owner_account TEXT NOT NULL, owner_public_key TEXT NOT NULL, wallet_account TEXT NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 0, policy_json TEXT NOT NULL, policy_revision INTEGER NOT NULL DEFAULT 0,
  budget_started_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agents_tenant ON agents (tenant_id, created_at);
CREATE TABLE IF NOT EXISTS policy_revisions (
  agent_id TEXT NOT NULL, revision INTEGER NOT NULL, policy_json TEXT NOT NULL, policy_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (agent_id, revision));
CREATE TABLE IF NOT EXISTS owner_intents (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, failure_code TEXT,
  request_json TEXT NOT NULL, payload_json TEXT NOT NULL, signer TEXT NOT NULL, result_json TEXT, idem_key TEXT, req_hash TEXT,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS owner_intents_idem ON owner_intents (tenant_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, credential TEXT UNIQUE NOT NULL, label TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS grants_agent ON grants (agent_id);
CREATE TABLE IF NOT EXISTS faucet_rejects (
  agent_id TEXT NOT NULL, wallet_account TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tenant_id TEXT NOT NULL, grant_id TEXT, type TEXT NOT NULL, status TEXT NOT NULL, failure_code TEXT, failure_detail TEXT,
  idem_key TEXT, req_hash TEXT, request_json TEXT NOT NULL, details_json TEXT, asset TEXT, amount TEXT, usd REAL NOT NULL DEFAULT 0, counted INTEGER NOT NULL DEFAULT 0,
  dispatch_committed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS operations_idem ON operations (agent_id, grant_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS operations_agent ON operations (agent_id, created_at);
`);

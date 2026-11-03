import fs from 'node:fs';
// HTTP routes for /v1: the Agent API (compatible with @near-intents-agent-api/sdk) on NEAR testnet.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { AgentApiError, errorDoc, fail } from './errors.js';
import { authenticate, issueKey, MAX_AGENTS_PER_KEY, REQUESTS_PER_MIN } from './partner-keys.js';
import { agentView, getAgent, policyView, walletView } from './agents.js';
import { generateIntent, getOwnerIntent, grantView, submitIntent } from './owner-intents.js';
import { balances, dryRun, history, KINDS, operationStatus, requireGrant, runAction, tokenList } from './executions.js';
import { VERIFIER } from '../config.mjs';

const send = (res, code, body, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...extra }); res.end(JSON.stringify(body)); };
const readJson = (req) => new Promise((ok, no) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 2e5) { no(fail(413, 'payload_too_large', 'request', 'Body is limited to 200 KB')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(fail(400, 'invalid_json', 'request', 'Body must be valid JSON')); } });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'REFUNDED', 'UNCERTAIN', 'NEEDS_REVIEW']);
const UNSUPPORTED = /^\/(agents\/[^/]+\/(shield|unshield|recover|native|approvals|containment|scheduled-executions|releases|proof)|proof|approvals|containment|scheduled-executions|releases|native)(\/|$)/;

const INDEX = (origin) => ({
  name: 'Tidepool Agent API (NEAR testnet)', version: 'v1', compatible_with: '@near-intents-agent-api/sdk', network: 'testnet',
  get_a_key: { method: 'POST', url: `${origin}/v1/keys`, body: { name: 'my-agent' }, note: 'Free, instant, no sign-up. Returns an naa_ key.' },
  docs: { quickstart: `${origin}/docs/guides/agent-api`, llms: `${origin}/llms.txt`, openapi: `${origin}/v1/openapi.json` },
  sdk: { baseUrl: origin },
});

export async function handleV1(req, res, url, { origin, ip, openapi }) {
  const requestId = 'req_' + crypto.randomBytes(8).toString('hex');
  const path = url.pathname.replace(/^\/v1/, '') || '/', q = url.searchParams, M = req.method;
  try {
    if (M === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, x-api-key, x-grant-token, idempotency-key', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '86400' }); return res.end(); }
    if (path === '/' && M === 'GET') return send(res, 200, INDEX(origin));
    if (path === '/e2e.js' && M === 'GET') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'access-control-allow-origin': '*' }); return res.end(fs.readFileSync(new URL('../../../site/public/agent-api-e2e.js', import.meta.url))); }
    if (path === '/openapi.json' && M === 'GET') return send(res, 200, openapi());
    if (path === '/keys' && M === 'POST') {
      const body = await readJson(req);
      const k = issueKey(body, ip);
      return send(res, 201, { ...k, usage: { base_url: origin, header: 'Authorization: Bearer ' + k.api_key, next: `${origin}/docs/guides/agent-api` } });
    }
    if (path === '/keys' && M === 'GET') return send(res, 200, INDEX(origin).get_a_key);
    const auth = authenticate(req), tenant = auth.tenantId;
    const agent = (id, o) => getAgent(tenant, id, o);

    if (path === '/whoami' && M === 'GET') return send(res, 200, { api_key_id: tenant, tenant_id: tenant });
    if (path === '/quotas' && M === 'GET') {
      const n = sql.prepare("SELECT COUNT(*) n FROM agents WHERE tenant_id = ? AND status = 'ACTIVE'").get(tenant).n;
      return send(res, 200, { revision: 1, overrides: {}, limits: { daily_agents: MAX_AGENTS_PER_KEY, api_keys: 1, requests_per_minute: REQUESTS_PER_MIN, key_requests_per_minute: REQUESTS_PER_MIN },
        usage: { agents_last_24_hours: n, api_keys: 1, requests_this_minute: auth.requestsThisMinute ?? 0 }, observed_at: new Date().toISOString() });
    }
    if (path === '/network' && M === 'GET') return send(res, 200, { network: 'near-testnet', contract_id: VERIFIER, supported_owner_types: ['near'], status: { overall: 'operational', checked_at: new Date().toISOString(), components: [{ name: 'near-testnet', status: 'operational' }, { name: 'tidepool-maker', status: 'operational' }] } });
    if (path === '/tokens' && M === 'GET') return send(res, 200, { data: await tokenList() });
    if (path === '/generate-intent' && M === 'POST') return send(res, 201, await generateIntent(tenant, await readJson(req), req.headers['idempotency-key']));
    if (path === '/submit-intent' && M === 'POST') return send(res, 202, submitIntent(tenant, await readJson(req)));
    if (path === '/status' && M === 'GET') {
      const corr = q.get('correlation_id');
      if (!corr) throw fail(400, 'validation_failed', 'request', 'correlation_id is required', { pointer: '/correlation_id' });
      const wait = Math.min(Math.max(parseInt(q.get('wait_ms'), 10) || 0, 0), 30_000), until = Date.now() + wait;
      for (;;) {
        const s = getOwnerIntent(tenant, corr) || await operationStatus(tenant, corr, { refresh: q.get('refresh'), getAgent: (id) => agent(id, { allowPending: true }) });
        if (!s) throw fail(404, 'not_found', 'request', `No execution or intent ${corr} for this API key`);
        if (TERMINAL.has(s.status) || s.status === 'PENDING_SIGNATURE' || Date.now() >= until) return send(res, 200, s);
        await sleep(Math.min(700, Math.max(until - Date.now(), 0)));
      }
    }
    if (path === '/agents' && M === 'GET') {
      const lim = Math.min(Math.max(parseInt(q.get('limit'), 10) || 50, 1), 100), cur = q.get('cursor'), ext = q.get('external_user_id');
      const rows = sql.prepare(`SELECT id FROM agents WHERE tenant_id = ? AND status = 'ACTIVE' ${ext ? 'AND external_user_id = ?' : ''} ${cur ? 'AND created_at < ?' : ''} ORDER BY created_at DESC LIMIT ?`).all(...[tenant, ...(ext ? [ext] : []), ...(cur ? [cur] : []), lim + 1]);
      const data = rows.slice(0, lim).map((r) => agentView(agent(r.id)));
      return send(res, 200, { data, next_cursor: rows.length > lim ? data[data.length - 1].created_at : null });
    }
    if (UNSUPPORTED.test(path)) throw fail(501, 'not_supported', 'api', 'This feature (shielding, native-chain wallets, approvals, scheduled executions, releases, proofs) is not available on Tidepool testnet');
    const m = path.match(/^\/agents\/([^/]+)(?:\/(.+))?$/);
    if (m) {
      const a = agent(decodeURIComponent(m[1])), sub = m[2] || '';
      if (M === 'GET') {
        if (sub === '') return send(res, 200, agentView(a));
        if (sub === 'wallet') return send(res, 200, walletView(a));
        if (sub === 'balances') { if (q.get('source') && q.get('source') !== 'intents') throw fail(400, 'validation_failed', 'request', 'source must be "intents" on Tidepool testnet', { pointer: '/source' }); return send(res, 200, await balances(a, { asset: q.get('asset') })); }
        if (sub === 'policy') return send(res, 200, policyView(a));
        if (sub === 'policy/history') return send(res, 200, { data: sql.prepare('SELECT * FROM policy_revisions WHERE agent_id = ? ORDER BY revision DESC').all(a.id).map((r) => ({ wallet_id: a.id, revision: r.revision, policy_hash: r.policy_hash, status: 'APPLIED', applied_at: r.created_at, transaction_hash: null, policy: JSON.parse(r.policy_json) })), next_cursor: null });
        if (sub === 'grants') return send(res, 200, { data: sql.prepare('SELECT * FROM grants WHERE agent_id = ? ORDER BY issued_at DESC').all(a.id).map((g) => grantView(g, a)), next_cursor: null });
        if (sub === 'history') return send(res, 200, history(a, { cursor: q.get('cursor'), limit: q.get('limit'), include_unpaid: q.get('include_unpaid') }));
      }
      if (M === 'POST' && KINDS.includes(sub)) {
        const body = await readJson(req);
        if (sub !== 'deposit' && body?.dry === true) return send(res, 200, await dryRun(a, sub, body));
        const grant = requireGrant(a, req.headers['x-grant-token']);
        return send(res, 202, await runAction(a, grant, sub, body, req.headers['idempotency-key'], ip));
      }
    }
    throw fail(404, 'not_found', 'request', `No route for ${M} /v1${path}. See ${origin}/v1 for an index.`);
  } catch (e) {
    if (e instanceof AgentApiError) return send(res, e.status, errorDoc(e, requestId), e.meta?.retry_after_seconds ? { 'retry-after': String(e.meta.retry_after_seconds) } : {});
    if (e?.code && Number.isInteger(e.code) && e.code < 500 && e.code >= 400) return send(res, e.code, errorDoc(fail(e.code, e.code === 429 ? 'rate_limited' : 'validation_failed', 'request', e.message), requestId));
    console.error('v1', path, e?.message);
    return send(res, 500, errorDoc(fail(500, 'internal_error', 'api', 'Unexpected error'), requestId));
  }
}

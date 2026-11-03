// JSON:API style errors for the Agent API: { errors: [{ status, code, layer, title, detail, meta }], meta: { request_id } }.
export class AgentApiError extends Error {
  constructor(status, code, layer, detail, meta) { super(detail); this.status = status; this.code = code; this.layer = layer; if (meta) this.meta = meta; }
}
export const fail = (status, code, layer, detail, meta) => new AgentApiError(status, code, layer, detail, meta);
const title = (c) => c.replace(/_/g, ' ').replace(/^./, (m) => m.toUpperCase());
export const errorDoc = (e, requestId) => {
  const { pointer, ...rest } = e.meta || {};
  return {
    errors: [{ status: String(e.status), code: e.code, layer: e.layer, title: title(e.code), detail: e.message, ...(pointer ? { source: { pointer } } : {}),
      meta: { retryable: e.status >= 500 || e.code === 'rate_limited' || e.code === 'wallet_busy', ...rest } }],
    meta: { request_id: requestId },
  };
};

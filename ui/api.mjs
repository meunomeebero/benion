// Reject stale account responses and keep uncertain writes distinguishable from reads.
export function createBrowserApi({ accountScope, assertScope, currentScope }) {
function scopedHeaders(scope, extra = {}) { return { 'X-Benion-Request': '1', ...(scope.id ? { 'X-Benion-Account': scope.id } : {}), ...extra }; }
async function apiRead(path, scope = accountScope(), scoped = true) {
  if (scoped) assertScope(scope);
  const response = await fetch(path, { headers: scoped ? scopedHeaders(scope) : { 'X-Benion-Request': '1' }, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) { const error = new Error('api-unavailable'); error.httpStatus = response.status; throw error; }
  const result = await response.json(); if (scoped) assertScope(scope); return result;
}
async function apiWrite(path, body, scope = accountScope(), scoped = true) {
  const csrfPath = path.startsWith('/api/connection') ? '/api/connection/csrf' : '/api/csrf';
  const csrf = await apiRead(csrfPath, scope, scoped);
  if (typeof csrf.nonce !== 'string' || csrf.nonce.length < 16) throw new Error('invalid-nonce');
  if (scoped) assertScope(scope);
  let response;
  try {
    response = await fetch(path, { method: 'POST', headers: { ...(scoped ? scopedHeaders(scope) : { 'X-Benion-Request': '1' }), 'Content-Type': 'application/json', 'X-Benion-CSRF': csrf.nonce }, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(body) });
    const result = await response.json();
    if (scoped && !currentScope(scope)) { const error = new Error('account-changed'); error.code = 'ACCOUNT_CHANGED'; error.httpStatus = response.status; const status = result.outcome || result.status || result.message?.status; if (['accepted', 'rejected', 'unknown'].includes(status)) error.confirmedStatus = status; throw error; }
    if (!response.ok) { const error = new Error('api-rejected'); error.httpStatus = response.status; error.code = result.error; error.mutationAttempted = true; throw error; }
    return result;
  } catch (error) { error.mutationAttempted = true; throw error; }
}
  return { apiRead, apiWrite, scopedHeaders };
}

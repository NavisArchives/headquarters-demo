import { getLeadsWorkspace, getLeadDatasets, saveDraft, clearDraft, getLead, ValidationError } from '../db.js';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export async function handleWorkspace(request, env, url) {
  const path = url.pathname;
  // Gmail lives in api/gmail.js now — a single proxy, one env name
  // (GMAIL_BRIDGE), and a mailbox sync that writes to D1 instead of the
  // browser's storage. This file used to shadow it from an earlier checkpoint.
  if (!['/api/leads/workspace', '/api/progress', '/api/leads/workspace/draft'].includes(path)) return null;
  try {
    // The Leads screen only needs the lists' names and notes: one small query,
    // not every lead a second time (6.8 MB, ~5.6 s from Lima; 13 Nov).
    if (request.method === 'GET' && path === '/api/leads/workspace' && url.searchParams.get('only') === 'datasets') {
      return json(await getLeadDatasets(env.DB));
    }
    if (request.method === 'GET' && path === '/api/leads/workspace') return json(await getLeadsWorkspace(env.DB));
    if (request.method === 'GET' && path === '/api/progress') return json((await getLeadsWorkspace(env.DB)).progress);
    // Retired (audit, 13 Nov): a browser backup could move a « passed » lead (a bounce,
    // an unsubscribe) back to « new ». Nothing in the app writes here any more.
    if (request.method === 'PUT' && path === '/api/progress') return json({ error: 'this route is retired; stages change from the Leads screen' }, 410);
    if (path === '/api/leads/workspace/draft' && ['PUT', 'DELETE'].includes(request.method)) {
      const input = await request.json();
      if (!/^(email|dm|follow):(EN|NL|FR)$|^__name$/.test(input.lang || '')) throw new ValidationError('Invalid draft language');
      if (!(await getLead(env.DB, input.uid))) return json({ error: 'No such lead' }, 404);
      if (request.method === 'DELETE') await clearDraft(env.DB, input.uid, input.lang);
      else await saveDraft(env.DB, input.uid, input.lang, input);
      return json({ saved: true });
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    if (error instanceof ValidationError || error instanceof SyntaxError) return json({ error: error.message }, 400);
    console.error('workspace:', error); return json({ error: 'Could not load or save Leads' }, 500);
  }
}

import { endpoint, clientIp, query } from '../server/http.js';
import { getAccount, getMe, postAccount, postMeCode, postMeVerify } from '../server/me.js';
import * as V from '../server/validate.js';

// GET ?k=<booking key>: the customer's details and cars (&account=1: the full My account view).
// POST { action: 'code', email } emails a code; { action: 'verify', email, code, remember } returns a key;
// { k, action: 'details' | 'prefs' | 'car' | 'remove-car', ... } changes their account.
export default endpoint(['GET', 'POST'], async (req, body) => {
  if (req.method === 'GET') return query(req, 'account') ? getAccount(query(req, 'k')) : getMe(query(req, 'k'));
  const action = (body as any)?.action;
  if (action === 'code' || action === 'verify') {
    const { action: _a, ...rest } = V.obj(body, ['action', 'email', 'code', 'remember']);
    return action === 'code' ? postMeCode(rest, clientIp(req)) : postMeVerify(rest, clientIp(req));
  }
  return postAccount(body);
});

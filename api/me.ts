import { endpoint, clientIp, query } from '../server/http.js';
import { getMe, postMeCode, postMeVerify } from '../server/me.js';
import * as V from '../server/validate.js';

// GET ?k=<booking key>: the customer's details and cars.
// POST { action: 'code', email } emails a code; { action: 'verify', email, code, remember } returns a key.
export default endpoint(['GET', 'POST'], async (req, body) => {
  if (req.method === 'GET') return getMe(query(req, 'k'));
  const { action, ...rest } = V.obj(body, ['action', 'email', 'code', 'remember']);
  if (action === 'code') return postMeCode(rest, clientIp(req));
  if (action === 'verify') return postMeVerify(rest, clientIp(req));
  throw new V.ValidationError('action', 'unknown');
});

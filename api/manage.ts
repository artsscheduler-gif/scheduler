import { endpoint, query } from '../server/http.js';
import { getManage, postCancel, postChangeServices, postReschedule } from '../server/public.js';
import * as V from '../server/validate.js';

// Everything a manage link can do, in one function (Vercel Hobby allows 12):
//   GET  ?t=…                      read-only view of the appointment
//   POST ?op=cancel                { t }
//   POST ?op=reschedule            { t, date, kind, start_time }
//   POST ?op=change-services       { t, service_ids, customer_notes, … }
export default endpoint(['GET', 'POST'], (req, body) => {
  if (req.method === 'GET') return getManage(query(req, 't'));
  const op = query(req, 'op');
  if (op === 'cancel') return postCancel(body);
  if (op === 'reschedule') return postReschedule(body);
  if (op === 'change-services') return postChangeServices(body);
  throw new V.ValidationError('op', 'unknown');
});

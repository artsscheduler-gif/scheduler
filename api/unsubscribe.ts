import { endpoint, query, type Req, type Res } from '../server/http.js';
import { postUnsubscribe } from '../server/public.js';

const json = endpoint(['POST'], (_req, body) => postUnsubscribe(body));

// Three ways in:
// - the unsubscribe page posts JSON { t, channel };
// - mail apps' one-click button (RFC 8058) POSTs "List-Unsubscribe=One-Click"
//   to the List-Unsubscribe URL, which carries the token as ?t=;
// - someone opening that URL in a browser is sent to the unsubscribe page.
export default async function handler(req: Req, res: Res) {
  const t = query(req, 't');
  if (req.method === 'GET' && t) {
    res.statusCode = 302;
    res.setHeader('Location', `/unsubscribe?t=${encodeURIComponent(t)}`);
    return res.end();
  }
  if (req.method === 'POST' && t) {
    try {
      await postUnsubscribe({ t, channel: 'email' });
      res.statusCode = 200;
    } catch {
      res.statusCode = 400; // bad or tampered token
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }
  return json(req, res);
}

import { endpoint } from '../server/http.js';
import { postUnsubscribe } from '../server/public.js';

export default endpoint(['POST'], (_req, body) => postUnsubscribe(body));

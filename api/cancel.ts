import { endpoint } from '../server/http.js';
import { postCancel } from '../server/public.js';

export default endpoint(['POST'], (_req, body) => postCancel(body));

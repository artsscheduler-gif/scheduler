import { endpoint, clientIp } from '../server/http.js';
import { postBook } from '../server/public.js';

export default endpoint(['POST'], (req, body) => postBook(body, clientIp(req)));

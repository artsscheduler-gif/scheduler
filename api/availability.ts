import { endpoint, clientIp } from '../server/http.js';
import { getAvailability } from '../server/public.js';

export default endpoint(['GET'], (req) => getAvailability(new URL(req.url ?? '/', 'http://x').searchParams, clientIp(req)));

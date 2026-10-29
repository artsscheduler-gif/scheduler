import { endpoint } from '../server/http.js';
import { postReschedule } from '../server/public.js';

export default endpoint(['POST'], (_req, body) => postReschedule(body));

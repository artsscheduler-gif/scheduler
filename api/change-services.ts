import { endpoint } from '../server/http.js';
import { postChangeServices } from '../server/public.js';

export default endpoint(['POST'], (_req, body) => postChangeServices(body));

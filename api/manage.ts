import { endpoint, query } from '../server/http.js';
import { getManage } from '../server/public.js';

// Read-only view of one appointment for the holder of a valid manage link.
export default endpoint(['GET'], (req) => getManage(query(req, 't')));

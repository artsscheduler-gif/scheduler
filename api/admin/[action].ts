import { endpoint, query } from '../../server/http.js';
import { adminAction } from '../../server/admin.js';

// Every admin write. Requires a Supabase session with role owner/staff and MFA.
export default endpoint(['POST'], (req, body) => adminAction(req, query(req, 'action') ?? '', body));

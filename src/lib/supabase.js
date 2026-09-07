import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.warn('[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — DB calls will fail.');
}

export const supabase = createClient(url || 'http://localhost', key || 'missing', {
  auth: { persistSession: false, autoRefreshToken: false }
});

export function dbError(res, error, status = 400) {
  console.error('[db]', error);
  return res.status(status).json({ error: error.message || 'Database error' });
}

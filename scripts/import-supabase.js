/* Loads everything from Supabase from the command line — the same load as the
 * button in Настройки → Данные из Supabase, but it neither checks nor sets the
 * button's once-only flag, so the button stays where it is.
 *
 *   docker compose run --rm app node scripts/import-supabase.js [--replace]
 *
 * Refuses to replace data that is already here unless --replace is given.
 * The data it replaces is saved as a backup first (see src/lib/backups.js).
 */

import 'dotenv/config';
import { pool } from '../src/lib/db.js';
import { migrate } from '../src/lib/migrate.js';
import { tablesWithData } from '../src/lib/dataset.js';
import { importFromSupabase } from '../src/lib/supabaseImport.js';

const REPLACE = process.argv.includes('--replace');

try {
  await migrate();
  const busy = await tablesWithData();
  if (busy.length && !REPLACE) {
    console.error(`The database already has data (${busy.join(', ')}). Run with --replace to overwrite it.`);
    process.exitCode = 1;
  } else {
    await importFromSupabase({ log: (m) => console.log(m), markDone: false });
  }
} catch (e) {
  console.error('Import failed:', e.message);
  process.exitCode = 1;
}

await pool.end();

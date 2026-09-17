-- The Supabase import is gone; its "already loaded" flag has nothing left to hide.
delete from app_settings where key = 'supabase_import';

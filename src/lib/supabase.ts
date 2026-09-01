import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey);
}

let client: SupabaseClient | undefined;

/** Undefined when the app is running against the demo dataset. */
export function getSupabase(): SupabaseClient | undefined {
  if (!isSupabaseConfigured()) return undefined;
  if (!client) client = createClient(url!, anonKey!);
  return client;
}

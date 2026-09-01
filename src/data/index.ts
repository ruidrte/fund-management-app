import { demoRepository } from './demoRepository';
import { supabaseRepository } from './supabaseRepository';
import { isSupabaseConfigured } from '../lib/supabase';
import type { Repository } from './repository';

export type { Repository, ClientSummary } from './repository';

/**
 * Supabase when it is configured, the demo dataset otherwise. The application
 * is fully usable either way, which is what keeps the demo path honest: it runs
 * the same engine and the same screens, not a cut-down version of them.
 */
export function getRepository(): Repository {
  return isSupabaseConfigured() ? supabaseRepository : demoRepository;
}

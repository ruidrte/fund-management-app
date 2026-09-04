import { unopenedRepository } from './unopenedRepository';
import { supabaseRepository } from './supabaseRepository';
import { isSupabaseConfigured } from '../lib/supabase';
import type { Repository } from './repository';

export type { Repository, ClientSummary } from './repository';

/**
 * Supabase when it is configured; otherwise the structure with nothing in it,
 * until a folder is connected under Storage. There is no third, invented
 * source: the application shows what was filed or it shows nothing.
 */
export function getRepository(): Repository {
  return isSupabaseConfigured() ? supabaseRepository : unopenedRepository;
}

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Centralized Supabase client for the whole app.
 *
 * SECURITY NOTE: only the public/publishable ("anon") key is ever read here.
 * The Supabase *secret* / service_role key must never be used or referenced
 * in frontend code — it must only ever live on a trusted server.
 */

/**
 * Snapshot of the page's URL hash/search taken synchronously at module
 * load — i.e. before `createClient` below runs its `detectSessionInUrl`
 * handling. That handling reads any auth tokens out of the URL (e.g. the
 * `type=signup` marker Supabase appends to an email-confirmation redirect)
 * and then scrubs them via `history.replaceState` as part of establishing
 * the session, all before React even mounts. Consumers that need to tell
 * "arrived via an email-confirmation link" apart from "arrived via a
 * normal page load" (AuthProvider's `justConfirmedEmail`) must read this
 * snapshot instead of the live `window.location`, which will already be
 * clean by the time any of our own effects run.
 */
export const authRedirectSnapshot =
  typeof window !== "undefined"
    ? { hash: window.location.hash, search: window.location.search }
    : { hash: "", search: "" };

const rawUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/**
 * The Supabase JS client expects the *base* project URL (e.g.
 * "https://xxxx.supabase.co"), not a specific REST/Auth sub-path — it builds
 * "/rest/v1", "/auth/v1", etc. on top of it internally. If VITE_SUPABASE_URL
 * was configured with a trailing path (e.g. ".../rest/v1/"), normalize it
 * down to its origin so auth/session requests don't end up double-nested.
 */
function toProjectOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export const supabaseUrl = rawUrl ? toProjectOrigin(rawUrl) : undefined;
export const isSupabaseConfigured = Boolean(supabaseUrl && publishableKey);

if (!isSupabaseConfigured) {
  // Non-fatal: the app must keep working without Supabase configured.
  // eslint-disable-next-line no-console
  console.warn(
    "[FontSeru] Supabase is not configured. Copy .env.example to .env and set " +
      "VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY to enable login."
  );
}

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl as string, publishableKey as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

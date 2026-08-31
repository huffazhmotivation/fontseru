import { supabase } from "@/lib/supabaseClient";
import { parseFontSeruProject, serializeFontSeruProject } from "./projectIO";
import type { FontSeruProject } from "@/types/project";

/**
 * Cloud storage for FontSeru projects (Supabase `public.projects` table —
 * see supabase/sql/projects_table.sql). This is purely additive to the
 * existing local IndexedDB autosave and manual .fs file download/upload:
 * neither of those is touched. A cloud project is stored as the exact same
 * JSON shape as a .fs file, so opening one on another device produces an
 * identical project.
 */

export interface CloudProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}

function requireClient() {
  if (!supabase) {
    throw new Error("Cloud save is not available: Supabase is not configured.");
  }
  return supabase;
}

/**
 * Progress reported back to the UI during `saveCloudProject`. There's no
 * native byte-level upload progress here (the payload is a single small
 * JSON request, not a chunked/streamed upload), so `percent` blends real
 * milestones (auth check done, request sent, response received) with a
 * gently-animated estimate while the request is actually in flight. This
 * is purely cosmetic — it exists so the UI never sits on a bare spinner
 * with zero feedback for many seconds.
 */
export interface CloudSaveProgress {
  percent: number; // 0-100
  label: string;
}

export interface CloudSaveOptions {
  onProgress?: (progress: CloudSaveProgress) => void;
  /** Lets the caller cancel a save that's taking too long / the user gave up on. */
  signal?: AbortSignal;
}

/**
 * Previously, a hung network request (bad wifi, a stalled DNS lookup, a
 * server that never responds) had no time limit at all: `fetch` doesn't
 * time out on its own, so the "Saving…" spinner could sit there forever
 * with no way to know whether it was still working or just stuck — and
 * the dialog's Cancel button was disabled while saving, so the only way
 * out was to force-reload the page. These timeouts make sure a stuck
 * request always surfaces as a clear, actionable error instead.
 */
const AUTH_CHECK_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 20_000;

class CloudTimeoutError extends Error {}

function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new CloudTimeoutError(message)), ms);
    Promise.resolve(promise).then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Cloud save was cancelled.", "AbortError");
  }
}

/** Animates `percent` from `from` towards (but never reaching) `to` while
 * a request is in flight, so the progress bar keeps visibly moving instead
 * of freezing. Call the returned function once the real result is in. */
function animateProgress(
  from: number,
  to: number,
  label: string,
  onProgress: ((progress: CloudSaveProgress) => void) | undefined
): () => void {
  let percent = from;
  onProgress?.({ percent: Math.round(percent), label });
  const interval = window.setInterval(() => {
    percent += (to - percent) * 0.12;
    onProgress?.({ percent: Math.round(percent), label });
  }, 220);
  return () => window.clearInterval(interval);
}

/** Lists the signed-in user's saved cloud projects, most recently updated first. */
export async function listCloudProjects(): Promise<CloudProjectSummary[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("projects")
    .select("id, name, updated_at")
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    updatedAt: row.updated_at as string,
  }));
}

/**
 * Saves (creates or overwrites) a cloud project under `name` for the
 * signed-in user. Overwriting-by-name mirrors local "Save" semantics and
 * relies on the `projects_user_id_name_key` unique index in the DB.
 */
export async function saveCloudProject(
  name: string,
  project: FontSeruProject,
  options?: CloudSaveOptions
): Promise<void> {
  const { onProgress, signal } = options ?? {};
  const client = requireClient();

  throwIfAborted(signal);
  onProgress?.({ percent: 5, label: "Menyiapkan data project…" });

  // Round-trip through the same serializer used for .fs files so the
  // stored JSON is byte-identical in shape to a downloaded project.
  const data = JSON.parse(serializeFontSeruProject(project));
  throwIfAborted(signal);
  onProgress?.({ percent: 20, label: "Memeriksa sesi login…" });

  let userId: string | undefined;
  try {
    const { data: userData, error: userError } = await withTimeout(
      client.auth.getUser(),
      AUTH_CHECK_TIMEOUT_MS,
      "Pemeriksaan sesi login memakan waktu terlalu lama. Periksa koneksi internet Anda dan coba lagi."
    );
    if (userError) throw new Error(userError.message);
    userId = userData.user?.id;
  } catch (error) {
    if (error instanceof CloudTimeoutError) throw new Error(error.message);
    throw error;
  }
  if (!userId) throw new Error("You must be signed in to save to the cloud.");
  throwIfAborted(signal);

  // A single small JSON request has no meaningful native "bytes uploaded"
  // progress, so we animate towards 90% while it's in flight and only jump
  // to 100% once the server has actually confirmed the write.
  const stopAnimating = animateProgress(35, 90, "Mengunggah ke Cloud…", onProgress);
  try {
    let query = client.from("projects").upsert({ user_id: userId, name, data }, { onConflict: "user_id,name" });
    if (signal) query = query.abortSignal(signal);
    const { error } = await withTimeout(
      query,
      UPLOAD_TIMEOUT_MS,
      "Unggah ke Cloud memakan waktu terlalu lama (kemungkinan koneksi internet bermasalah). Coba lagi."
    );
    if (error) throw new Error(error.message);
  } catch (error) {
    if (error instanceof CloudTimeoutError) throw new Error(error.message);
    throw error;
  } finally {
    stopAnimating();
  }

  onProgress?.({ percent: 100, label: "Tersimpan di Cloud" });
}

/** Downloads and parses one cloud project by id. */
export async function loadCloudProject(id: string): Promise<{ name: string; project: FontSeruProject }> {
  const client = requireClient();
  const { data, error } = await client
    .from("projects")
    .select("name, data")
    .eq("id", id)
    .single();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Cloud project not found.");

  // Re-validate through the normal parser (format/version checks) even
  // though this came from our own table, so a corrupted/manually-edited
  // row fails the same way a bad .fs file would instead of silently
  // hydrating a broken project.
  const project = parseFontSeruProject(JSON.stringify(data.data));
  return { name: data.name as string, project };
}

/** Total bytes used across all of the signed-in user's cloud projects
 * (server-computed via `get_project_storage_usage`, which is naturally
 * scoped to their own rows). Used to show a usage indicator before saving
 * — the database trigger `projects_enforce_quota` is the real limit; this
 * is only for a friendlier heads-up in the UI. */
export const CLOUD_STORAGE_QUOTA_BYTES = 100 * 1024 * 1024; // 100 MB, mirrors the SQL trigger

export async function getCloudStorageUsage(): Promise<number> {
  const client = requireClient();
  const { data, error } = await client.rpc("get_project_storage_usage");
  if (error) throw new Error(error.message);
  return typeof data === "number" ? data : Number(data ?? 0);
}

/** Permanently deletes one of the signed-in user's cloud projects. */
export async function deleteCloudProject(id: string): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("projects").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

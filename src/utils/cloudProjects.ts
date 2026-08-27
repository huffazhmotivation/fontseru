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
export async function saveCloudProject(name: string, project: FontSeruProject): Promise<void> {
  const client = requireClient();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError) throw new Error(userError.message);
  const userId = userData.user?.id;
  if (!userId) throw new Error("You must be signed in to save to the cloud.");

  // Round-trip through the same serializer used for .fs files so the
  // stored JSON is byte-identical in shape to a downloaded project.
  const data = JSON.parse(serializeFontSeruProject(project));

  const { error } = await client
    .from("projects")
    .upsert({ user_id: userId, name, data }, { onConflict: "user_id,name" });

  if (error) throw new Error(error.message);
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

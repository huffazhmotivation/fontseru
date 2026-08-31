import { supabase } from "@/lib/supabaseClient";
import { parseFontSeruProject, serializeFontSeruProject } from "./projectIO";
import type { FontSeruProject } from "@/types/project";

/**
 * Cloud storage for FontSeru projects (Supabase `public.projects` table —
 * see supabase/sql/projects_table.sql). This is purely additive to the
 * existing local IndexedDB autosave and manual .fs file download/upload:
 * neither of those is touched. A cloud project round-trips to the exact
 * same project shape as a .fs file, so opening one on another device
 * produces an identical project — see `wrapPayload`/`unwrapPayload` below
 * for the (transparent, backward-compatible) on-the-wire encoding.
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
 * native byte-level upload progress here (the payload is a single JSON
 * request, not a chunked/streamed upload), so `percent` blends real
 * milestones (compression done, auth check done, request sent, response
 * received) with a gently-animated estimate while the request is actually
 * in flight. This is purely cosmetic — it exists so the UI never sits on a
 * bare spinner with zero feedback for many seconds.
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
 *
 * The upload timeout is *not* a single fixed number: a project with a
 * couple of glyphs and one with hundreds of glyphs' worth of vector paths
 * can differ in payload size by two orders of magnitude, so a timeout
 * sized for the small case will fire on a large-but-perfectly-healthy
 * upload before it ever gets a chance to finish (this is what previously
 * showed as "stuck at ~90%, then just vanishes" for glyph-heavy projects:
 * the request was still genuinely in flight, not actually stuck, when the
 * fixed 20s timeout cut it off). `uploadTimeoutFor` below scales the
 * budget with the *compressed* payload size instead.
 */
const AUTH_CHECK_TIMEOUT_MS = 10_000;
const MIN_UPLOAD_TIMEOUT_MS = 20_000;
const MAX_UPLOAD_TIMEOUT_MS = 120_000;
/** Conservative assumed throughput floor for the timeout budget — real
 * uploads are usually much faster than this; it only needs to be large
 * enough that a slow-but-working connection isn't cut off early. */
const ASSUMED_MIN_BYTES_PER_SEC = 50_000;

function uploadTimeoutFor(payloadBytes: number): number {
  const budget = 15_000 + (payloadBytes / ASSUMED_MIN_BYTES_PER_SEC) * 1000;
  return Math.min(MAX_UPLOAD_TIMEOUT_MS, Math.max(MIN_UPLOAD_TIMEOUT_MS, Math.ceil(budget)));
}

class CloudTimeoutError extends Error {}

/**
 * Races `promise` against a timeout. Unlike a bare `Promise.race`, the
 * timeout here is wired to `onTimeout` so the *caller* can actually cancel
 * the underlying work (e.g. abort the in-flight request) instead of just
 * walking away from it while it keeps running unseen in the background —
 * that mismatch (UI says "failed", server may still get the write a few
 * seconds later) was a secondary source of the "saved but not really, or
 * maybe it partially did" confusion on large projects.
 */
function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  message: string,
  onTimeout?: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      onTimeout?.();
      reject(new CloudTimeoutError(message));
    }, ms);
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

/**
 * Supabase/PostgREST errors carry a Postgres error `code` alongside a raw
 * `message` — the raw message is often written for a DBA, not an end
 * user (e.g. "canceling statement due to statement timeout" for Postgres
 * code 57014, which is what a slow/overloaded database — a throttled Disk
 * IO budget, a missing index, a big query — looks like from the client).
 * This translates the handful of codes users can actually hit into
 * something actionable; anything unrecognized falls back to the raw
 * message rather than hiding it.
 */
function describePostgrestError(error: { message: string; code?: string }): string {
  switch (error.code) {
    case "57014": // query_canceled (statement_timeout)
      return "Server database sedang lambat merespons dan membatalkan permintaan ini (timeout). Ini biasanya sementara — coba lagi dalam beberapa saat.";
    case "42501": // insufficient_privilege (RLS denied)
      return "Anda tidak punya akses untuk aksi ini. Pastikan akun Anda berstatus PRO dan sedang login.";
    default:
      return error.message;
  }
}

function throwPostgrestError(error: { message: string; code?: string }): never {
  throw new Error(describePostgrestError(error));
}

/**
 * On-the-wire encoding for the `data` column. Font/glyph JSON is highly
 * repetitive (lots of numeric path coordinates and repeated key names), so
 * gzip typically shrinks it by 70–90%. That directly fixes the "large
 * projects fail to upload" issue: a project that was, say, 8MB of raw JSON
 * (easily the case for a few hundred glyphs) usually compresses down to
 * under 1MB, which uploads in a couple of seconds even on a modest
 * connection — instead of timing out or grinding along at the very edge of
 * the old fixed 20s budget.
 *
 * jsonb can't hold raw binary, so the compressed bytes are base64-encoded
 * before being wrapped in a small JSON envelope. Old rows saved before
 * this change (or ones saved from a browser without `CompressionStream`
 * support) are plain project JSON with no envelope — `unwrapPayload`
 * detects and handles both shapes, so nothing needs to be migrated.
 */
const GZIP_ENVELOPE_MARKER = "fontseru.cloud.gzip.v1";

interface GzipEnvelope {
  __fontseru: typeof GZIP_ENVELOPE_MARKER;
  /** Base64-encoded gzip bytes of the UTF-8 project JSON. */
  gz: string;
}

function isGzipEnvelope(value: unknown): value is GzipEnvelope {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { __fontseru?: unknown }).__fontseru === GZIP_ENVELOPE_MARKER &&
    typeof (value as { gz?: unknown }).gz === "string"
  );
}

function supportsGzipStreams(): boolean {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

/** Base64-encodes in fixed-size chunks — `String.fromCharCode(...bytes)` on
 * a large array can blow the call stack, which matters here precisely
 * because large projects are the case we're trying to fix. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gzipCompress(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzipDecompress(bytes: Uint8Array): Promise<string> {
  // `bytes` always comes from `base64ToBytes` above — a freshly allocated,
  // non-shared, offset-0 buffer — so this cast is safe; it's only needed
  // because TS's DOM lib types `Uint8Array.buffer` as the broader
  // `ArrayBufferLike` (which also covers `SharedArrayBuffer`, not a valid
  // `BlobPart`) rather than the concrete `ArrayBuffer` it is here.
  const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

/** Compresses project JSON for upload when the browser supports it, falling
 * back to sending it uncompressed (identical to the previous behavior) when
 * it doesn't. Returns the value to store plus its actual on-the-wire byte
 * size, which drives `uploadTimeoutFor`. */
async function wrapPayload(json: string): Promise<{ value: unknown; bytes: number }> {
  if (!supportsGzipStreams()) {
    const value = JSON.parse(json);
    return { value, bytes: new TextEncoder().encode(json).length };
  }
  const gz = await gzipCompress(json);
  const envelope: GzipEnvelope = { __fontseru: GZIP_ENVELOPE_MARKER, gz: bytesToBase64(gz) };
  return { value: envelope, bytes: gz.length };
}

async function unwrapPayload(value: unknown): Promise<string> {
  if (isGzipEnvelope(value)) {
    return gzipDecompress(base64ToBytes(value.gz));
  }
  // Pre-compression row, or a save made from a browser without
  // CompressionStream support: `value` is already the raw project object.
  return JSON.stringify(value);
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

  if (error) throwPostgrestError(error);
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
  const json = serializeFontSeruProject(project);
  throwIfAborted(signal);
  onProgress?.({ percent: 12, label: "Mengompresi data…" });

  // See `wrapPayload` — this is what lets projects with a lot of glyphs
  // upload quickly and reliably instead of timing out.
  const { value: data, bytes } = await wrapPayload(json);
  throwIfAborted(signal);
  onProgress?.({ percent: 25, label: "Memeriksa sesi login…" });

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

  // A single JSON request has no meaningful native "bytes uploaded"
  // progress, so we animate towards 90% while it's in flight and only jump
  // to 100% once the server has actually confirmed the write.
  const stopAnimating = animateProgress(35, 90, "Mengunggah ke Cloud…", onProgress);
  // A separate controller (not the caller's `signal` directly) so a
  // *timeout* can abort the request the same way a user-initiated cancel
  // does, without requiring the caller to pass an already-abortable signal.
  const uploadController = new AbortController();
  const onExternalAbort = () => uploadController.abort();
  signal?.addEventListener("abort", onExternalAbort);
  try {
    const query = client
      .from("projects")
      .upsert({ user_id: userId, name, data }, { onConflict: "user_id,name" })
      .abortSignal(uploadController.signal);
    const { error } = await withTimeout(
      query,
      uploadTimeoutFor(bytes),
      "Unggah ke Cloud memakan waktu terlalu lama (kemungkinan koneksi internet bermasalah, atau project ini berukuran sangat besar). Coba lagi.",
      () => uploadController.abort()
    );
    if (error) throwPostgrestError(error);
  } catch (error) {
    if (error instanceof CloudTimeoutError) throw new Error(error.message);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onExternalAbort);
    stopAnimating();
  }

  onProgress?.({ percent: 100, label: "Tersimpan di Cloud" });
}

export interface CloudLoadOptions {
  onProgress?: (progress: CloudSaveProgress) => void;
  /** Lets the caller cancel an open that's taking too long / the user gave up on. */
  signal?: AbortSignal;
}

/** Generous fixed budget for downloading one project row. Unlike uploads,
 * we don't know the payload size up front, but since projects are now
 * stored gzip-compressed (see `wrapPayload`), even a glyph-heavy project is
 * typically a small download — this only needs to be large enough to not
 * cut off someone on a genuinely slow connection. */
const DOWNLOAD_TIMEOUT_MS = 45_000;

/** Downloads, decompresses, and parses one cloud project by id. */
export async function loadCloudProject(
  id: string,
  options?: CloudLoadOptions
): Promise<{ name: string; project: FontSeruProject }> {
  const { onProgress, signal } = options ?? {};
  const client = requireClient();

  throwIfAborted(signal);
  onProgress?.({ percent: 8, label: "Menghubungi Cloud…" });

  // Same rationale as the upload side: no native download-progress events
  // for a single-row select, so animate towards 90% while it's in flight.
  const stopAnimating = animateProgress(20, 90, "Mengunduh project…", onProgress);
  const downloadController = new AbortController();
  const onExternalAbort = () => downloadController.abort();
  signal?.addEventListener("abort", onExternalAbort);

  let row: { name: string; data: unknown };
  try {
    const query = client
      .from("projects")
      .select("name, data")
      .eq("id", id)
      .abortSignal(downloadController.signal)
      .single();
    const { data, error } = await withTimeout(
      query,
      DOWNLOAD_TIMEOUT_MS,
      "Mengunduh project dari Cloud memakan waktu terlalu lama (kemungkinan koneksi internet bermasalah). Coba lagi.",
      () => downloadController.abort()
    );
    if (error) throwPostgrestError(error);
    if (!data) throw new Error("Cloud project not found.");
    row = data as { name: string; data: unknown };
  } catch (error) {
    if (error instanceof CloudTimeoutError) throw new Error(error.message);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onExternalAbort);
    stopAnimating();
  }

  throwIfAborted(signal);
  onProgress?.({ percent: 95, label: "Membuka project…" });

  // Re-validate through the normal parser (format/version checks) even
  // though this came from our own table, so a corrupted/manually-edited
  // row fails the same way a bad .fs file would instead of silently
  // hydrating a broken project.
  const json = await unwrapPayload(row.data);
  const project = parseFontSeruProject(json);

  onProgress?.({ percent: 100, label: "Project dimuat" });
  return { name: row.name, project };
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
  if (error) throwPostgrestError(error);
  return typeof data === "number" ? data : Number(data ?? 0);
}

/** Permanently deletes one of the signed-in user's cloud projects. */
export async function deleteCloudProject(id: string): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("projects").delete().eq("id", id);
  if (error) throwPostgrestError(error);
}

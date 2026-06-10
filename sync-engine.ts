import { Notice, Vault, TFile, TAbstractFile } from "obsidian";
import { SupabaseClient } from "@supabase/supabase-js";
import { loadSyncState, saveSyncState, pruneStaleEntries, SyncState } from "./state";
import { computeChecksum } from "./hash";

const BUCKET = "obsidian-vault";
const TABLE = "file_sync";

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

interface RemoteFileRecord {
	path: string;
	checksum: string;
	updated_at: string;
	size: number;
	deleted?: boolean;
	updated_by?: string;
}

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	deleted: number;
	errors: string[];
	newPruneTime?: string;
}

export type ProgressCallback = (current: number, total: number) => void;

// ────────────────────────────────────────────
// Retry utility
// ────────────────────────────────────────────

/** HTTP status codes that indicate non-transient errors (not worth retrying). */
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 405, 409, 422]);

/**
 * Retry an async operation with exponential backoff.
 * Only retries on transient/network errors. Auth errors, validation
 * errors (4xx), and similar are not retried.
 *
 * Detection uses structured prefixes from our error messages
 * (e.g. "Storage upload failed for path: message") and checks for
 * HTTP status codes rather than substring-matching on file paths.
 */
async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	maxRetries = 2,
	baseDelayMs = 1000
): Promise<T> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			// Don't retry on the last attempt
			if (attempt === maxRetries) break;
			// Don't retry on non-transient errors detected by HTTP status code
			if (isNonRetryableError(lastError)) break;
			const delay = baseDelayMs * Math.pow(2, attempt);
			console.log(`[supabase-sync] Retry ${attempt + 1}/${maxRetries} for operation after ${delay}ms`);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	throw lastError!;
}

/**
 * Determine whether an error is non-transient (should not be retried).
 * Checks for HTTP status code patterns in the message and well-known
 * Supabase error strings rather than matching on arbitrary substrings
 * that could collide with file paths.
 */
function isNonRetryableError(err: Error): boolean {
	const msg = err.message;
	// Check for HTTP status codes embedded in Supabase error messages
	const statusMatch = msg.match(/\b(\d{3})\b/);
	if (statusMatch) {
		const code = parseInt(statusMatch[1], 10);
		if (NON_RETRYABLE_STATUS_CODES.has(code)) return true;
	}
	// Check for well-known Supabase auth/permission error prefixes
	const lowerMsg = msg.toLowerCase();
	if (lowerMsg.startsWith("invalid jwt") ||
		lowerMsg.startsWith("permission denied") ||
		lowerMsg.startsWith("unauthorized")) {
		return true;
	}
	return false;
}

// ────────────────────────────────────────────
// Batch processing utility
// ────────────────────────────────────────────

/**
 * Process items in parallel with a concurrency limit.
 * Prevents sequential blocking on large vaults.
 */
async function batchProcess<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>
): Promise<void> {
	let index = 0;

	async function worker(): Promise<void> {
		while (index < items.length) {
			const i = index++;
			await fn(items[i]);
		}
	}

	const workers: Promise<void>[] = [];
	for (let w = 0; w < Math.min(concurrency, items.length); w++) {
		workers.push(worker());
	}
	await Promise.all(workers);
}

// ────────────────────────────────────────────
// Low-level file operations
// ────────────────────────────────────────────

function getContentType(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "md": return "text/markdown";
		case "png": return "image/png";
		case "jpg":
		case "jpeg": return "image/jpeg";
		case "gif": return "image/gif";
		case "webp": return "image/webp";
		case "pdf": return "application/pdf";
		case "mp3": return "audio/mpeg";
		case "wav": return "audio/wav";
		case "m4a": return "audio/mp4";
		case "json": return "application/json";
		case "canvas": return "application/json";
		default: return "application/octet-stream";
	}
}

/**
 * Upload a file to Supabase Storage and upsert its metadata row.
 * Wrapped with retry logic for transient network failures.
 */
async function uploadFile(
	supabase: SupabaseClient,
	path: string,
	content: string | ArrayBuffer,
	checksum: string,
	deviceId: string,
	deviceName: string
): Promise<void> {
	await retryWithBackoff(async () => {
		const contentType = getContentType(path);
		const { error: storageErr } = await supabase.storage
			.from(BUCKET)
			.upload(path, content, { upsert: true, contentType });

		if (storageErr) {
			throw new Error(`Storage upload failed for ${path}: ${storageErr.message}`);
		}

		const size = typeof content === "string" ? new Blob([content]).size : content.byteLength;
		const updatedBy = `${deviceId}:${deviceName}`;
		const { error: dbErr } = await supabase.from(TABLE).upsert(
			{ path, checksum, size, deleted: false, deleted_at: null, updated_by: updatedBy },
			{ onConflict: "path" }
		);

		if (dbErr) {
			throw new Error(`Metadata upsert failed for ${path}: ${dbErr.message}`);
		}
	});
}

/**
 * Download only the binary content of a remote file from Supabase storage.
 * Wrapped with retry logic for transient network failures.
 */
async function downloadRemoteContent(
	supabase: SupabaseClient,
	path: string
): Promise<ArrayBuffer> {
	return retryWithBackoff(async () => {
		const { data, error } = await supabase.storage.from(BUCKET).download(path);

		if (error || !data) {
			throw new Error(`Storage download failed for ${path}: ${error?.message ?? "no data"}`);
		}

		return await data.arrayBuffer();
	});
}

/**
 * Write binary content to a local file, creating parent directories if necessary.
 */
async function writeLocalFile(
	vault: Vault,
	path: string,
	content: ArrayBuffer
): Promise<void> {
	const existingFile = vault.getAbstractFileByPath(path);
	if (existingFile instanceof TFile) {
		await vault.modifyBinary(existingFile, content);
	} else {
		const dir = path.substring(0, path.lastIndexOf("/"));
		if (dir) {
			try {
				await vault.createFolder(dir);
			} catch {
				// folder already exists
			}
		}
		await vault.createBinary(path, content);
	}
}

/**
 * Download a file from Supabase Storage and create/update it locally as binary.
 */
async function downloadFile(
	supabase: SupabaseClient,
	vault: Vault,
	path: string
): Promise<ArrayBuffer> {
	const content = await downloadRemoteContent(supabase, path);
	await writeLocalFile(vault, path, content);
	return content;
}

/**
 * Mark a file as deleted in the remote file_sync table and remove
 * its storage object. Uses soft-delete semantics so other clients
 * can detect the deletion on their next sync.
 * Wrapped with retry logic for transient network failures.
 */
async function deleteFileRemotely(
	supabase: SupabaseClient,
	path: string,
	deviceId: string,
	deviceName: string
): Promise<void> {
	await retryWithBackoff(async () => {
		// Remove from storage (ignore errors — file may already be gone)
		await supabase.storage.from(BUCKET).remove([path]);

		// Soft-delete the metadata row
		const updatedBy = `${deviceId}:${deviceName}`;
		const { error: dbErr } = await supabase.from(TABLE).upsert(
			{ path, deleted: true, deleted_at: new Date().toISOString(), updated_by: updatedBy },
			{ onConflict: "path" }
		);

		if (dbErr) {
			throw new Error(`Failed to mark ${path} as deleted: ${dbErr.message}`);
		}
	});
}

/**
 * Delete a file from the local vault.
 */
async function deleteFileLocally(
	vault: Vault,
	path: string
): Promise<void> {
	const file = vault.getAbstractFileByPath(path);
	if (file instanceof TFile) {
		await vault.delete(file);
	}
}

/**
 * Formats a conflict filepath alongside the original file.
 * e.g., folder/note.md -> folder/note.conflict-deviceName-YYYY-MM-DD-HHmmss.md
 */
function getConflictPath(
	originalPath: string,
	deviceName: string,
	updatedAtStr: string
): string {
	const extIndex = originalPath.lastIndexOf(".");
	const base = extIndex !== -1 ? originalPath.substring(0, extIndex) : originalPath;
	const ext = extIndex !== -1 ? originalPath.substring(extIndex) : "";

	let formattedTime = "unknown-time";
	const date = new Date(updatedAtStr);
	if (!isNaN(date.getTime())) {
		const yyyy = date.getFullYear();
		const mm = String(date.getMonth() + 1).padStart(2, "0");
		const dd = String(date.getDate()).padStart(2, "0");
		const hh = String(date.getHours()).padStart(2, "0");
		const min = String(date.getMinutes()).padStart(2, "0");
		const ss = String(date.getSeconds()).padStart(2, "0");
		formattedTime = `${yyyy}-${mm}-${dd}-${hh}${min}${ss}`;
	}

	const sanitizedDevice = (deviceName || "device").replace(/[^a-zA-Z0-9_-]/g, "_");
	return `${base}.conflict-${sanitizedDevice}-${formattedTime}${ext}`;
}

// ────────────────────────────────────────────
// Rename handler (called from vault.on('rename'))
// ────────────────────────────────────────────

/**
 * Handle a local file rename. Uploads the file under its new path,
 * marks the old path as deleted remotely, and updates local state.
 */
export async function handleLocalRename(
	supabase: SupabaseClient,
	vault: Vault,
	newPath: string,
	oldPath: string,
	deviceId: string,
	deviceName: string
): Promise<void> {
	if (newPath.startsWith(".obsidian/")) return;

	try {
		const file = vault.getAbstractFileByPath(newPath);
		if (!(file instanceof TFile)) return;

		// Skip if new file size exceeds 5 MB constraint (only applies to non-.md files)
		if (file.extension !== "md" && file.stat.size >= 5 * 1024 * 1024) return;

		const content = await vault.readBinary(file);
		const checksum = await computeChecksum(content);

		// Upload under new path
		await uploadFile(supabase, newPath, content, checksum, deviceId, deviceName);

		// Mark old path as deleted remotely
		if (!oldPath.startsWith(".obsidian/")) {
			await deleteFileRemotely(supabase, oldPath, deviceId, deviceName);
		}

		// Update local state
		const localState = await loadSyncState(vault);
		delete localState[oldPath];
		localState[newPath] = {
			checksum,
			synced_at: new Date().toISOString(),
		};
		await saveSyncState(vault, localState);

		new Notice(`Synced rename: ${oldPath} → ${newPath}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[supabase-sync] Rename sync error:`, msg);
		new Notice(`Sync failed for rename: ${msg}`);
	}
}

// ────────────────────────────────────────────
// Delete handler (called from vault.on('delete'))
// ────────────────────────────────────────────

/**
 * Handle a local file deletion. Marks the file as deleted remotely.
 */
export async function handleLocalDelete(
	supabase: SupabaseClient,
	vault: Vault,
	path: string,
	deviceId: string,
	deviceName: string
): Promise<void> {
	if (path.startsWith(".obsidian/")) return;

	try {
		await deleteFileRemotely(supabase, path, deviceId, deviceName);

		// Update local state
		const localState = await loadSyncState(vault);
		if (localState[path]) {
			localState[path].deleted = true;
			localState[path].synced_at = new Date().toISOString();
		}
		await saveSyncState(vault, localState);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[supabase-sync] Delete sync error:`, msg);
		new Notice(`Sync failed for delete ${path}: ${msg}`);
	}
}

// ────────────────────────────────────────────
// Full bidirectional sync
// ────────────────────────────────────────────

/**
 * Perform a full bidirectional sync between the local vault and Supabase.
 *
 * Uses 3-way merge logic:
 *   - localChecksum vs lastKnownChecksum vs remoteChecksum
 *   - Only when both local AND remote differ from last known is it a true conflict.
 */
export async function sync(
	supabase: SupabaseClient,
	vault: Vault,
	deviceId: string,
	deviceName: string,
	lastRemotePruneTime: string,
	onProgress?: ProgressCallback
): Promise<SyncResult> {
	const result: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, errors: [] };

	// 1. Load local state
	const localState = await loadSyncState(vault);

	// 2. Fetch all remote metadata rows in one query (including updated_by)
	const { data: remoteRows, error: fetchErr } = await supabase
		.from(TABLE)
		.select("path, checksum, updated_at, size, deleted, updated_by");

	if (fetchErr) {
		throw new Error(`Failed to fetch remote metadata: ${fetchErr.message}`);
	}

	const remoteMap = new Map<string, RemoteFileRecord>();
	for (const row of (remoteRows ?? []) as RemoteFileRecord[]) {
		remoteMap.set(row.path, row);
	}

	// 3. Build a map of local syncable files (skip .obsidian/, support .md + non-.md under 5 MB)
	const localFiles = vault
		.getFiles()
		.filter((f) => !f.path.startsWith(".obsidian/") && (f.extension === "md" || f.stat.size < 5 * 1024 * 1024));

	const localFileMap = new Map<string, TFile>();
	for (const file of localFiles) {
		localFileMap.set(file.path, file);
	}

	// 4. Build a set of all paths to process
	const allPaths = new Set<string>();
	for (const f of localFiles) allPaths.add(f.path);
	for (const [rp] of remoteMap) {
		if (!rp.startsWith(".obsidian/")) {
			allPaths.add(rp);
		}
	}

	// 5. Process all paths with batched concurrency
	const pathList = Array.from(allPaths);
	let processed = 0;
	const total = pathList.length;

	// Circuit breaker: abort processing if too many consecutive files fail
	const MAX_CONSECUTIVE_FAILURES = 5;
	let consecutiveFailures = 0;

	await batchProcess(pathList, 5, async (path: string) => {
		// Check circuit breaker before processing each file
		if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			result.errors.push(`${path}: skipped (circuit breaker — ${MAX_CONSECUTIVE_FAILURES} consecutive failures)`);
			processed++;
			if (onProgress) onProgress(processed, total);
			return;
		}

		const file = localFileMap.get(path);
		const remote = remoteMap.get(path);
		const lastKnown = localState[path];

		try {
			const existsLocally = !!file;
			const existsRemotely = !!remote;
			const remoteDeleted = remote?.deleted === true;

			// ── Case A: File exists locally, not in remote ──
			if (existsLocally && !existsRemotely) {
				if (lastKnown?.deleted) {
					// We previously synced a deletion but file reappeared locally.
					// Treat as a new file — re-upload.
				}
				// New local file → upload
				const content = await vault.readBinary(file!);
				const checksum = await computeChecksum(content);
				await uploadFile(supabase, path, content, checksum, deviceId, deviceName);
				localState[path] = { checksum, synced_at: new Date().toISOString() };
				result.uploaded++;
			}

			// ── Case B: File exists locally AND remotely ──
			else if (existsLocally && existsRemotely) {
				if (remoteDeleted) {
					// Remote says this was deleted
					if (lastKnown) {
						// We had it synced before; respect the remote delete
						await deleteFileLocally(vault, path);
						localState[path] = {
							checksum: lastKnown.checksum,
							synced_at: new Date().toISOString(),
							deleted: true,
						};
						result.deleted++;
					} else {
						// No prior state — file is new locally but remote was deleted.
						// Local wins: re-upload.
						const content = await vault.readBinary(file!);
						const checksum = await computeChecksum(content);
						await uploadFile(supabase, path, content, checksum, deviceId, deviceName);
						localState[path] = { checksum, synced_at: new Date().toISOString() };
						result.uploaded++;
					}
				} else {
					// Remote is not deleted — normal sync
					const content = await vault.readBinary(file!);
					const localChecksum = await computeChecksum(content);
					const remoteChecksum = remote!.checksum;
					const lastKnownChecksum = lastKnown?.checksum;

					if (localChecksum === remoteChecksum) {
						// Already in sync — seed state if missing
						if (!lastKnown) {
							localState[path] = {
								checksum: localChecksum,
								synced_at: new Date().toISOString(),
							};
						}
					} else if (!lastKnownChecksum) {
						// No prior state — first sync for this file.
						// Safe bootstrapping using conflict copy instead of silent overwrite
						const remoteTime = new Date(remote!.updated_at).getTime();
						const localTime = file!.stat.mtime;
						const remoteDevice = remote!.updated_by || "remote";
						const remoteDeviceName = remoteDevice.includes(":") ? remoteDevice.split(":")[1] : remoteDevice;

						if (localTime >= remoteTime) {
							// Local is newer. Keep local as main file, download remote as conflict copy.
							const remoteContent = await downloadRemoteContent(supabase, path);
							const conflictPath = getConflictPath(path, remoteDeviceName, remote!.updated_at);
							await writeLocalFile(vault, conflictPath, remoteContent);
							new Notice(`⚠️ Conflict bootstrap on ${path}: remote version saved as ${conflictPath.split("/").pop()}`, 6000);

							// Upload local to remote to establish this version
							await uploadFile(supabase, path, content, localChecksum, deviceId, deviceName);
							localState[path] = { checksum: localChecksum, synced_at: new Date().toISOString() };
							result.uploaded++;
						} else {
							// Remote is newer. Keep remote as main file, save local as conflict copy.
							const localTimeISO = new Date(localTime).toISOString();
							const conflictPath = getConflictPath(path, deviceName, localTimeISO);
							await writeLocalFile(vault, conflictPath, content);
							new Notice(`⚠️ Conflict bootstrap on ${path}: local version saved as ${conflictPath.split("/").pop()}`, 6000);

							// Download remote file to main path
							const downloaded = await downloadFile(supabase, vault, path);
							const dlChecksum = await computeChecksum(downloaded);
							localState[path] = { checksum: dlChecksum, synced_at: new Date().toISOString() };
							result.downloaded++;
						}
					} else if (localChecksum !== lastKnownChecksum && remoteChecksum === lastKnownChecksum) {
						// Only local changed → upload
						await uploadFile(supabase, path, content, localChecksum, deviceId, deviceName);
						localState[path] = { checksum: localChecksum, synced_at: new Date().toISOString() };
						result.uploaded++;
					} else if (localChecksum === lastKnownChecksum && remoteChecksum !== lastKnownChecksum) {
						// Only remote changed → download
						const downloaded = await downloadFile(supabase, vault, path);
						const dlChecksum = await computeChecksum(downloaded);
						localState[path] = { checksum: dlChecksum, synced_at: new Date().toISOString() };
						result.downloaded++;
					} else {
						// Both changed — true conflict.
						// Keep local as primary file, download remote content to a conflict copy.
						const remoteDevice = remote!.updated_by || "remote";
						const remoteDeviceName = remoteDevice.includes(":") ? remoteDevice.split(":")[1] : remoteDevice;
						console.warn(
							`[supabase-sync] TRUE CONFLICT on ${path}: both local and remote changed since last sync. Saving remote as conflict copy.`
						);
						const remoteContent = await downloadRemoteContent(supabase, path);
						const conflictPath = getConflictPath(path, remoteDeviceName, remote!.updated_at);
						await writeLocalFile(vault, conflictPath, remoteContent);
						new Notice(`⚠️ Conflict on ${path}: remote version saved as ${conflictPath.split("/").pop()}`, 6000);

						// Upload local version as primary, resolving conflict
						await uploadFile(supabase, path, content, localChecksum, deviceId, deviceName);
						localState[path] = { checksum: localChecksum, synced_at: new Date().toISOString() };
						result.uploaded++;
					}
				}
			}

			// ── Case C: File missing locally, exists remotely ──
			else if (!existsLocally && existsRemotely) {
				if (remoteDeleted) {
					// Both sides agree it's gone — clean up state
					if (localState[path]) {
						localState[path].deleted = true;
						localState[path].synced_at = new Date().toISOString();
					}
				} else if (lastKnown && !lastKnown.deleted) {
					// We previously synced this file but it's gone locally.
					// This is a local deletion → propagate to remote.
					await deleteFileRemotely(supabase, path, deviceId, deviceName);
					localState[path] = {
						checksum: lastKnown.checksum,
						synced_at: new Date().toISOString(),
						deleted: true,
					};
					result.deleted++;
				} else if (!lastKnown) {
					// Never synced before and not present locally → genuinely new remote file → download
					const downloaded = await downloadFile(supabase, vault, path);
					const dlChecksum = await computeChecksum(downloaded);
					localState[path] = { checksum: dlChecksum, synced_at: new Date().toISOString() };
					result.downloaded++;
				}
				// else: lastKnown.deleted === true → already handled, skip
			}

			// Reset circuit breaker on success
			consecutiveFailures = 0;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[supabase-sync] Error syncing ${path}:`, msg);
			result.errors.push(`${path}: ${msg}`);
			consecutiveFailures++;
		}

		processed++;
		if (onProgress) {
			onProgress(processed, total);
		}
	});

	// 6. Prune stale state entries
	const localPaths = new Set(localFiles.map((f) => f.path));
	const remotePaths = new Set(remoteMap.keys());
	const prunedState = pruneStaleEntries(localState, localPaths, remotePaths);

	// 7. Persist local state
	await saveSyncState(vault, prunedState);

	// 8. Clean up remote soft-deleted rows older than 30 days (Issue #3), once every 24h
	const now = new Date();
	let shouldPrune = true;
	if (lastRemotePruneTime) {
		const lastPrune = new Date(lastRemotePruneTime);
		if (!isNaN(lastPrune.getTime())) {
			const oneDayMs = 24 * 60 * 60 * 1000;
			if (now.getTime() - lastPrune.getTime() < oneDayMs) {
				shouldPrune = false;
			}
		}
	}

	if (shouldPrune) {
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		const { error: pruneErr } = await supabase
			.from(TABLE)
			.delete()
			.eq("deleted", true)
			.lt("deleted_at", thirtyDaysAgo.toISOString());

		if (pruneErr) {
			console.warn(`[supabase-sync] Failed to prune remote soft-deleted rows:`, pruneErr.message);
		} else {
			result.newPruneTime = now.toISOString();
		}
	}

	// 9. Log structured error summary
	if (result.errors.length > 0) {
		console.error(
			`[supabase-sync] Sync completed with ${result.errors.length} error(s):\n` +
			result.errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n")
		);
	}

	return result;
}

// ────────────────────────────────────────────
// Realtime change handler
// ────────────────────────────────────────────

/**
 * Handle a realtime change from the file_sync table.
 * Properly differentiates between INSERT/UPDATE and DELETE events.
 *
 * For INSERT/UPDATE, performs full 3-way conflict detection:
 *   - localChecksum vs lastKnownChecksum vs remoteChecksum
 *   - If both local and remote changed since last sync, saves remote
 *     as a conflict copy instead of silently overwriting local edits.
 */
export async function handleRealtimeChange(
	supabase: SupabaseClient,
	vault: Vault,
	payload: {
		eventType: "INSERT" | "UPDATE" | "DELETE";
		new: Record<string, any>;
		old: Record<string, any>;
	}
): Promise<void> {
	const { eventType } = payload;

	if (eventType === "DELETE") {
		// DELETE events have data in payload.old (requires REPLICA IDENTITY FULL)
		const path = payload.old?.path;
		if (!path) {
			console.warn(
				"[supabase-sync] Realtime DELETE event received with empty payload.old. " +
				"This usually means REPLICA IDENTITY FULL is not set on the file_sync table. " +
				"Run: ALTER TABLE file_sync REPLICA IDENTITY FULL;"
			);
			return;
		}
		if (!path.endsWith(".md") || path.startsWith(".obsidian/")) return;

		try {
			await deleteFileLocally(vault, path);

			const localState = await loadSyncState(vault);
			if (localState[path]) {
				localState[path].deleted = true;
				localState[path].synced_at = new Date().toISOString();
			}
			await saveSyncState(vault, localState);

			new Notice(`Deleted via remote: ${path}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[supabase-sync] Realtime DELETE error for ${path}:`, msg);
			new Notice(`Sync failed for delete ${path}: ${msg}`);
		}
		return;
	}

	// INSERT or UPDATE
	const path = payload.new?.path;
	const remoteChecksum = payload.new?.checksum;
	const remoteDeleted = payload.new?.deleted === true;
	const remoteUpdatedBy = payload.new?.updated_by || "remote";
	const remoteDeviceName = remoteUpdatedBy.includes(":") ? remoteUpdatedBy.split(":")[1] : remoteUpdatedBy;
	const remoteUpdatedAt = payload.new?.updated_at || new Date().toISOString();

	if (!path || !path.endsWith(".md") || path.startsWith(".obsidian/")) return;

	// If the remote record was soft-deleted, delete locally
	if (remoteDeleted) {
		try {
			await deleteFileLocally(vault, path);

			const localState = await loadSyncState(vault);
			if (localState[path]) {
				localState[path].deleted = true;
				localState[path].synced_at = new Date().toISOString();
			}
			await saveSyncState(vault, localState);

			new Notice(`Deleted via remote: ${path}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[supabase-sync] Realtime soft-delete error for ${path}:`, msg);
			new Notice(`Sync failed for delete ${path}: ${msg}`);
		}
		return;
	}

	try {
		const localState = await loadSyncState(vault);
		const lastKnown = localState[path];
		const lastKnownChecksum = lastKnown?.checksum;

		// Read actual current local file content (not just state checksum)
		const localFile = vault.getAbstractFileByPath(path);
		const existsLocally = localFile instanceof TFile;

		if (!existsLocally) {
			// File doesn't exist locally → just download
			const downloaded = await downloadFile(supabase, vault, path);
			const dlChecksum = await computeChecksum(downloaded);
			localState[path] = {
				checksum: dlChecksum,
				synced_at: new Date().toISOString(),
			};
			await saveSyncState(vault, localState);
			new Notice(`Synced remote change: ${path}`);
			return;
		}

		// File exists locally — perform 3-way conflict detection
		const localContent = await vault.readBinary(localFile);
		const localChecksum = await computeChecksum(localContent);

		if (localChecksum === remoteChecksum) {
			// Already in sync — seed state if missing
			if (!lastKnown) {
				localState[path] = {
					checksum: localChecksum,
					synced_at: new Date().toISOString(),
				};
				await saveSyncState(vault, localState);
			}
			return;
		}

		if (!lastKnownChecksum) {
			// No prior sync state — can't determine who changed.
			// Be safe: download remote as conflict copy, keep local.
			console.warn(
				`[supabase-sync] Realtime: no prior state for ${path}, saving remote as conflict copy`
			);
			const remoteContent = await downloadRemoteContent(supabase, path);
			const conflictPath = getConflictPath(path, remoteDeviceName, remoteUpdatedAt);
			await writeLocalFile(vault, conflictPath, remoteContent);
			new Notice(`⚠️ Conflict on ${path}: remote saved as ${conflictPath.split("/").pop()}`, 6000);

			localState[path] = {
				checksum: localChecksum,
				synced_at: new Date().toISOString(),
			};
			await saveSyncState(vault, localState);
		} else if (localChecksum === lastKnownChecksum && remoteChecksum !== lastKnownChecksum) {
			// Only remote changed → safe to download
			const downloaded = await downloadFile(supabase, vault, path);
			const dlChecksum = await computeChecksum(downloaded);
			localState[path] = {
				checksum: dlChecksum,
				synced_at: new Date().toISOString(),
			};
			await saveSyncState(vault, localState);
			new Notice(`Synced remote change: ${path}`);
		} else if (localChecksum !== lastKnownChecksum && remoteChecksum === lastKnownChecksum) {
			// Only local changed — remote is stale, skip download.
			// The next full sync or debounced modify will upload local changes.
			console.log(
				`[supabase-sync] Realtime: local has unsaved changes for ${path}, skipping remote download`
			);
		} else {
			// Both changed — true conflict.
			// Keep local as primary, download remote as conflict copy.
			console.warn(
				`[supabase-sync] Realtime TRUE CONFLICT on ${path}: both local and remote changed. Saving remote as conflict copy.`
			);
			const remoteContent = await downloadRemoteContent(supabase, path);
			const conflictPath = getConflictPath(path, remoteDeviceName, remoteUpdatedAt);
			await writeLocalFile(vault, conflictPath, remoteContent);
			new Notice(`⚠️ Conflict on ${path}: remote saved as ${conflictPath.split("/").pop()}`, 6000);

			// Update state to reflect local is current
			localState[path] = {
				checksum: localChecksum,
				synced_at: new Date().toISOString(),
			};
			await saveSyncState(vault, localState);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[supabase-sync] Realtime sync error for ${path}:`, msg);
		new Notice(`Sync failed for ${path}: ${msg}`);
	}
}

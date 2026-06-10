import { Vault } from "obsidian";

const STATE_PATH = ".obsidian/supabase-sync-state.json";

export interface SyncFileState {
	checksum: string;
	synced_at: string; // ISO timestamp
	deleted?: boolean; // true if the file was intentionally deleted
}

export interface SyncState {
	[path: string]: SyncFileState;
}

/**
 * Read the local sync state file. Returns an empty object if
 * the file does not exist or cannot be parsed.
 *
 * Backward-compatible: old entries without `deleted` default to false.
 */
export async function loadSyncState(vault: Vault): Promise<SyncState> {
	try {
		const exists = await vault.adapter.exists(STATE_PATH);
		if (!exists) return {};
		const raw = await vault.adapter.read(STATE_PATH);
		return JSON.parse(raw) as SyncState;
	} catch {
		return {};
	}
}

/**
 * Persist the sync state to the local state file.
 */
export async function saveSyncState(
	vault: Vault,
	state: SyncState
): Promise<void> {
	await vault.adapter.write(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Remove stale entries from the state that no longer exist in either
 * the local vault or the remote file set. This prevents the state
 * file from growing unboundedly with high note churn.
 */
export function pruneStaleEntries(
	state: SyncState,
	localPaths: Set<string>,
	remotePaths: Set<string>
): SyncState {
	const pruned: SyncState = {};
	for (const path of Object.keys(state)) {
		if (localPaths.has(path) || remotePaths.has(path)) {
			pruned[path] = state[path];
		}
		// else: path exists in neither local nor remote — drop it
	}
	return pruned;
}

import { Notice, Plugin, TFile, Platform, setIcon } from "obsidian";
import { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { createSupabaseClient } from "./supabase";
import {
	SupabaseSyncSettings,
	DEFAULT_SETTINGS,
	SupabaseSyncSettingTab,
} from "./settings";
import {
	sync,
	handleRealtimeChange,
	handleLocalRename,
	handleLocalDelete,
	SyncResult,
} from "./sync-engine";

export default class SupabaseSyncPlugin extends Plugin {
	settings: SupabaseSyncSettings = DEFAULT_SETTINGS;
	supabase: SupabaseClient | null = null;
	realtimeChannel: RealtimeChannel | null = null;
	syncIntervalId: number | null = null;
	lastSyncTime: string | null = null;
	isSyncing = false;

	statusBarItemEl: HTMLElement;
	private statusRevertTimer: ReturnType<typeof setTimeout> | null = null;

	// Promise-based mutex to serialize sync operations (Issue #6)
	private syncMutex: Promise<void> = Promise.resolve();

	// Debounce timer for modify-triggered sync (Issue #8)
	private modifyDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private static readonly MODIFY_DEBOUNCE_MS = 5000;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new SupabaseSyncSettingTab(this.app, this));

		// Init Supabase client if credentials are configured
		this.initSupabaseClient();

		// Register commands
		this.addCommand({
			id: "sync-vault-now",
			name: "Sync vault now",
			callback: () => this.runSync(/* isManual */ true),
		});

		this.addCommand({
			id: "show-sync-status",
			name: "Show sync status",
			callback: () => this.showSyncStatus(),
		});

		// Wait for workspace to be ready before auto-sync, realtime, and hooks
		this.app.workspace.onLayoutReady(() => {
			this.statusBarItemEl = this.addStatusBarItem();
			this.updateStatusBar("idle");
			this.statusBarItemEl.onClickEvent(() => {
				this.runSync(true);
			});

			if (this.settings.autoSyncOnStartup && this.supabase) {
				this.runSync();
			}
			this.setupRealtimeSubscription();
			this.setupSyncInterval();
			this.setupVaultHooks();
		});
	}

	onunload(): void {
		this.teardownRealtimeSubscription();
		this.clearSyncInterval();
		if (this.modifyDebounceTimer) {
			clearTimeout(this.modifyDebounceTimer);
		}
		if (this.statusRevertTimer) {
			clearTimeout(this.statusRevertTimer);
		}
	}

	// ── Status Bar ────────────────────────────

	private updateStatusBar(status: "idle" | "syncing" | "success" | "error", tooltip?: string) {
		if (!this.statusBarItemEl) return;
		this.statusBarItemEl.empty();
		let iconName = "cloud";
		let defaultTooltip = "Supabase Sync: Idle";

		this.statusBarItemEl.removeClass("supabase-sync-spinning");

		if (status === "syncing") {
			iconName = "refresh-cw";
			defaultTooltip = "Supabase Sync: Syncing...";
			this.statusBarItemEl.addClass("supabase-sync-spinning");
		} else if (status === "success") {
			iconName = "check-circle";
			defaultTooltip = "Supabase Sync: Success";
		} else if (status === "error") {
			iconName = "alert-circle";
			defaultTooltip = "Supabase Sync: Error";
		}

		setIcon(this.statusBarItemEl, iconName);
		this.statusBarItemEl.setAttribute("aria-label", tooltip || defaultTooltip);

		if (this.statusRevertTimer) {
			clearTimeout(this.statusRevertTimer);
			this.statusRevertTimer = null;
		}

		// Revert to idle after 5 seconds
		if (status === "success" || status === "error") {
			this.statusRevertTimer = setTimeout(() => {
				if (!this.isSyncing) {
					this.updateStatusBar("idle");
				}
			}, 5000);
		}
	}

	// ── Settings ──────────────────────────────

	private generateDefaultDeviceName(isMobile: boolean): string {
		const type = isMobile ? "Mobile" : "Desktop";
		const rand = Math.random().toString(36).substring(2, 6);
		return `${type}-${rand}`;
	}

	/**
	 * Generate a UUID v4 for unique device identity.
	 * Uses crypto.randomUUID() when available (Electron/modern WebViews),
	 * falls back to a manual implementation.
	 */
	private generateDeviceId(): string {
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
			return crypto.randomUUID();
		}
		// Fallback: manual UUID v4
		return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
			const r = (Math.random() * 16) | 0;
			const v = c === "x" ? r : (r & 0x3) | 0x8;
			return v.toString(16);
		});
	}

	/**
	 * Check if a local file is syncable: markdown files of any size,
	 * or other files under 5 MB in size. Excludes the configuration folder.
	 */
	isSyncableFile(file: TFile): boolean {
		if (file.path.startsWith(".obsidian/")) return false;
		if (file.extension === "md") return true;
		return file.stat.size < 5 * 1024 * 1024;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		let needsSave = false;
		if (!this.settings.deviceName) {
			this.settings.deviceName = this.generateDefaultDeviceName(Platform.isMobile);
			needsSave = true;
		}
		if (!this.settings.deviceId) {
			this.settings.deviceId = this.generateDeviceId();
			needsSave = true;
		}
		if (needsSave) {
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Re-init client when settings change
		this.initSupabaseClient();
		this.teardownRealtimeSubscription();
		this.setupRealtimeSubscription();
		this.clearSyncInterval();
		this.setupSyncInterval();
	}

	// ── Supabase client ──────────────────────

	private initSupabaseClient(): void {
		if (this.settings.supabaseUrl && this.settings.serviceRoleKey) {
			this.supabase = createSupabaseClient(
				this.settings.supabaseUrl,
				this.settings.serviceRoleKey
			);
		} else {
			this.supabase = null;
		}
	}

	// ── Network awareness ────────────────────

	/**
	 * Check if the device is online and, when syncOnWifiOnly is enabled,
	 * whether the connection is Wi-Fi (not cellular).
	 */
	private isNetworkSuitable(isManual: boolean): boolean {
		// Always allow manual sync regardless of network type
		if (isManual) {
			// Still block if fully offline
			if (typeof navigator !== "undefined" && !navigator.onLine) {
				new Notice("You are offline. Sync skipped.");
				return false;
			}
			return true;
		}

		// Auto-sync: check online status
		if (typeof navigator !== "undefined" && !navigator.onLine) {
			console.log("[supabase-sync] Offline — skipping auto-sync.");
			return false;
		}

		// Auto-sync: check Wi-Fi-only preference
		if (this.settings.syncOnWifiOnly) {
			const conn = (navigator as any)?.connection;
			if (conn && conn.type === "cellular") {
				console.log("[supabase-sync] On cellular — skipping auto-sync (Wi-Fi only mode).");
				return false;
			}
		}

		return true;
	}

	// ── Sync ─────────────────────────────────

	/**
	 * Acquire the sync mutex, then run the sync.
	 * This serializes all sync operations to prevent concurrent state corruption.
	 */
	async runSync(isManual = false): Promise<void> {
		if (!this.supabase) {
			new Notice("Supabase Sync: Please configure your Supabase URL and key in settings.");
			return;
		}

		if (!this.isNetworkSuitable(isManual)) {
			return;
		}

		// Queue behind any in-progress sync via mutex
		this.syncMutex = this.syncMutex.then(() => this.executeSyncLocked(isManual));
	}

	private async executeSyncLocked(isManual: boolean): Promise<void> {
		if (!this.supabase) return;

		if (this.isSyncing) {
			new Notice("Sync already in progress...");
			return;
		}

		this.isSyncing = true;
		this.updateStatusBar("syncing", "Sync started...");

		try {
			let lastNoticeTime = 0;
			const result: SyncResult = await sync(
				this.supabase,
				this.app.vault,
				this.settings.deviceId,
				this.settings.deviceName,
				this.settings.lastRemotePruneTime,
				(current: number, total: number) => {
					// Throttle progress updates to every 2 seconds
					const now = Date.now();
					if (now - lastNoticeTime > 2000) {
						this.updateStatusBar("syncing", `Syncing... (${current}/${total})`);
						lastNoticeTime = now;
					}
				}
			);

			if (result.newPruneTime) {
				this.settings.lastRemotePruneTime = result.newPruneTime;
				await this.saveData(this.settings);
			}

			this.lastSyncTime = new Date().toISOString();

			let msg = `Sync complete. ↑${result.uploaded} ↓${result.downloaded}`;
			if (result.deleted > 0) {
				msg += ` 🗑${result.deleted}`;
			}
			msg += " files";
			if (result.errors.length > 0) {
				msg += `\n⚠️ ${result.errors.length} error(s):`;
				const shown = result.errors.slice(0, 3);
				for (const e of shown) {
					// Extract just the path (before the colon)
					const filePath = e.split(":")[0]?.trim() || e;
					msg += `\n  • ${filePath}`;
				}
				if (result.errors.length > 3) {
					msg += `\n  + ${result.errors.length - 3} more`;
				}
				this.updateStatusBar("error", "Sync completed with errors");
			} else {
				this.updateStatusBar("success", msg);
			}

			// Only show Notice popup on error or if triggered manually
			if (result.errors.length > 0 || isManual) {
				new Notice(msg, result.errors.length > 0 ? 8000 : 4000);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("[supabase-sync] Sync failed:", msg);
			this.updateStatusBar("error", `Sync failed`);
			if (isManual) new Notice(`Sync failed: ${msg}`);
		} finally {
			this.isSyncing = false;
			// Only clear if not in an error/success state that's waiting to revert
			if (this.statusBarItemEl && this.statusBarItemEl.getAttribute("aria-label")?.includes("Syncing")) {
				this.updateStatusBar("idle");
			}
		}
	}

	private showSyncStatus(): void {
		const time = this.lastSyncTime
			? new Date(this.lastSyncTime).toLocaleString()
			: "Never";
		const syncableFiles = this.app.vault
			.getFiles()
			.filter(
				(f) => this.isSyncableFile(f)
			).length;

		new Notice(
			`Supabase Sync Status\nLast sync: ${time}\nSynced files: ${syncableFiles}\nAuto-sync: ${
				this.settings.autoSyncInterval > 0
					? `every ${this.settings.autoSyncInterval} min`
					: "disabled"
			}\nWi-Fi only: ${this.settings.syncOnWifiOnly ? "yes" : "no"}`
		);
	}

	// ── Vault hooks ──────────────────────────

	private setupVaultHooks(): void {
		// Rename hook (Issue #1): propagate renames to remote.
		// No isSyncing guard — the mutex serializes; dropping events
		// would silently lose renames that happen during a full sync.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.supabase) return;
				if (!(file instanceof TFile)) return;
				if (file.path.startsWith(".obsidian/")) return;

				const newIsSyncable = this.isSyncableFile(file);
				const oldWasPossiblySyncable = !oldPath.startsWith(".obsidian/");

				if (newIsSyncable) {
					this.syncMutex = this.syncMutex.then(() =>
						handleLocalRename(this.supabase!, this.app.vault, file.path, oldPath, this.settings.deviceId, this.settings.deviceName)
					);
				} else if (oldWasPossiblySyncable) {
					this.syncMutex = this.syncMutex.then(() =>
						handleLocalDelete(this.supabase!, this.app.vault, oldPath, this.settings.deviceId, this.settings.deviceName)
					);
				}
			})
		);

		// Delete hook (Issue #2): propagate deletions to remote.
		// No isSyncing guard — queued behind mutex like all other mutations.
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.supabase) return;
				if (!(file instanceof TFile)) return;
				if (file.path.startsWith(".obsidian/")) return;

				this.syncMutex = this.syncMutex.then(() =>
					handleLocalDelete(this.supabase!, this.app.vault, file.path, this.settings.deviceId, this.settings.deviceName)
				);
			})
		);

		// Modify hook (Issue #8): debounced sync on file save.
		// Much more reliable than quit-based sync on mobile where the OS
		// can suspend the process milliseconds after the quit event.
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!this.supabase) return;
				if (!(file instanceof TFile)) return;
				if (!this.isSyncableFile(file)) return;

				// Reset debounce timer — sync 5s after last modification
				if (this.modifyDebounceTimer) {
					clearTimeout(this.modifyDebounceTimer);
				}
				this.modifyDebounceTimer = setTimeout(() => {
					this.modifyDebounceTimer = null;
					this.runSync();
				}, SupabaseSyncPlugin.MODIFY_DEBOUNCE_MS);
			})
		);
	}

	// ── Realtime ─────────────────────────────

	private setupRealtimeSubscription(): void {
		if (!this.supabase) return;

		this.realtimeChannel = this.supabase
			.channel("vault-sync")
			.on(
				"postgres_changes",
				{
					event: "*",
					schema: "public",
					table: "file_sync",
				},
				async (payload: any) => {
					if (!this.supabase) return;

					// Ignore events triggered by this device to avoid feedback loops
					const updatedBy = payload.new?.updated_by ?? payload.old?.updated_by;
					if (updatedBy) {
						const [eventDeviceId] = updatedBy.split(":");
						if (eventDeviceId === this.settings.deviceId) {
							return;
						}
					}

					// Queue the realtime handler on the mutex so it executes after any active sync
					this.syncMutex = this.syncMutex.then(async () => {
						try {
							await handleRealtimeChange(
								this.supabase!,
								this.app.vault,
								{
									eventType: payload.eventType,
									new: payload.new ?? {},
									old: payload.old ?? {},
								}
							);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							console.error("[supabase-sync] Realtime handler error:", msg);
						}
					});
				}
			)
			.subscribe();
	}

	private teardownRealtimeSubscription(): void {
		if (this.realtimeChannel) {
			this.supabase?.removeChannel(this.realtimeChannel);
			this.realtimeChannel = null;
		}
	}

	// ── Interval ─────────────────────────────

	private setupSyncInterval(): void {
		if (this.settings.autoSyncInterval > 0) {
			const ms = this.settings.autoSyncInterval * 60 * 1000;
			this.syncIntervalId = window.setInterval(() => {
				this.runSync();
			}, ms);
			// Register with Obsidian so it gets cleared on unload
			this.registerInterval(this.syncIntervalId);
		}
	}

	private clearSyncInterval(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}
}

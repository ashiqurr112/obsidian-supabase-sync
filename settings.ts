import { App, PluginSettingTab, Setting } from "obsidian";
import type SupabaseSyncPlugin from "./main";

export interface SupabaseSyncSettings {
	supabaseUrl: string;
	serviceRoleKey: string;
	autoSyncOnStartup: boolean;
	autoSyncInterval: number; // minutes, 0 = disabled
	syncOnWifiOnly: boolean;
	deviceName: string;
	deviceId: string; // UUID, auto-generated once, used for identity in realtime filtering
	lastRemotePruneTime: string;
}

export const DEFAULT_SETTINGS: SupabaseSyncSettings = {
	supabaseUrl: "",
	serviceRoleKey: "",
	autoSyncOnStartup: false,
	autoSyncInterval: 0,
	syncOnWifiOnly: false,
	deviceName: "",
	deviceId: "",
	lastRemotePruneTime: "",
};

export class SupabaseSyncSettingTab extends PluginSettingTab {
	plugin: SupabaseSyncPlugin;
	private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(app: App, plugin: SupabaseSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Debounced save: waits 500ms after the last call before persisting.
	 * Prevents re-initialising the Supabase client on every keystroke.
	 */
	private debouncedSave(): void {
		if (this.saveDebounceTimer) {
			clearTimeout(this.saveDebounceTimer);
		}
		this.saveDebounceTimer = setTimeout(async () => {
			await this.plugin.saveSettings();
			this.saveDebounceTimer = null;
		}, 500);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Supabase Sync Settings" });

		// ── Setup guidance ──
		const infoEl = containerEl.createDiv({ cls: "setting-item" });
		const infoDesc = infoEl.createDiv({ cls: "setting-item-description" });
		infoDesc.style.width = "100%";
		infoDesc.style.marginBottom = "12px";

		const noteBox = infoDesc.createEl("div");
		noteBox.style.background = "var(--background-modifier-message)";
		noteBox.style.border = "1px solid var(--background-modifier-border)";
		noteBox.style.borderRadius = "6px";
		noteBox.style.padding = "10px 14px";
		noteBox.style.fontSize = "13px";
		noteBox.style.lineHeight = "1.5";

		noteBox.createEl("strong", { text: "⚠️ Required PostgreSQL setup: " });
		noteBox.createSpan({
			text: "Run ",
		});
		noteBox.createEl("code", {
			text: "ALTER TABLE file_sync REPLICA IDENTITY FULL;",
		});
		noteBox.createSpan({
			text: " in your Supabase SQL editor. Without this, remote file deletions will not propagate to your devices.",
		});

		noteBox.createEl("br");
		noteBox.createEl("br");
		noteBox.createEl("strong", { text: "📄 Sync scope: " });
		noteBox.createSpan({
			text: "Markdown (.md) files of any size and other vault files (images, PDFs, audio, canvas files, etc.) under 5 MB are synced.",
		});

		new Setting(containerEl)
			.setName("Supabase URL")
			.setDesc("Your Supabase project URL")
			.addText((text) =>
				text
					.setPlaceholder("https://xxxxx.supabase.co")
					.setValue(this.plugin.settings.supabaseUrl)
					.onChange((value) => {
						this.plugin.settings.supabaseUrl = value.trim();
						this.debouncedSave();
					})
			);

		new Setting(containerEl)
			.setName("Service role key")
			.setDesc("Your Supabase service_role key (keep secret)")
			.addText((text) => {
				text
					.setPlaceholder("eyJhbGciOiJIUzI1NiIs...")
					.setValue(this.plugin.settings.serviceRoleKey)
					.onChange((value) => {
						this.plugin.settings.serviceRoleKey = value.trim();
						this.debouncedSave();
					});
				// Mask the key input
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Auto-sync on startup")
			.setDesc("Automatically sync when Obsidian starts")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSyncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-sync interval (minutes)")
			.setDesc("Automatically sync on an interval. Set to 0 to disable.")
			.addText((text) =>
				text
					.setPlaceholder("0")
					.setValue(String(this.plugin.settings.autoSyncInterval))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						this.plugin.settings.autoSyncInterval = isNaN(parsed)
							? 0
							: Math.max(0, parsed);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sync on Wi-Fi only")
			.setDesc(
				"Skip automatic sync when on a cellular connection (mobile only). " +
				"Manual sync is always allowed."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnWifiOnly)
					.onChange(async (value) => {
						this.plugin.settings.syncOnWifiOnly = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Device name")
			.setDesc(
				"A human-readable label for this device, used in conflict file names. " +
				"Device identity for sync is handled by an auto-generated UUID (" +
				(this.plugin.settings.deviceId || "not yet generated") +
				"), so this name does not need to be unique."
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g. laptop-ubuntu")
					.setValue(this.plugin.settings.deviceName)
					.onChange(async (value) => {
						this.plugin.settings.deviceName = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Manual sync")
			.setDesc("Trigger a sync immediately")
			.addButton((btn) =>
				btn
					.setButtonText("Sync now")
					.setCta()
					.onClick(() => this.plugin.runSync())
			);
	}
}

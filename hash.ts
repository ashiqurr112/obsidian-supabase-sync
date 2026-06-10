/**
 * Compute a hex-encoded SHA-256 checksum of the given string content.
 *
 * Uses the Web Crypto API (available in Obsidian's Electron env and
 * modern mobile WebViews) for performance — ~10x faster than a pure-JS
 * MD5 for large files.
 */
export async function computeChecksum(content: string | ArrayBuffer): Promise<string> {
	const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

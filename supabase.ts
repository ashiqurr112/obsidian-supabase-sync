import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { requestUrl } from "obsidian";

/**
 * Derive a conventional status text from an HTTP status code.
 */
function statusTextFromCode(status: number): string {
	const map: Record<number, string> = {
		200: "OK", 201: "Created", 204: "No Content",
		301: "Moved Permanently", 304: "Not Modified",
		400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
		404: "Not Found", 405: "Method Not Allowed", 409: "Conflict",
		422: "Unprocessable Entity", 429: "Too Many Requests",
		500: "Internal Server Error", 502: "Bad Gateway",
		503: "Service Unavailable",
	};
	return map[status] ?? "";
}

/**
 * Minimal Headers-like object that satisfies the Supabase SDK's
 * internal usage — supports get(), has(), forEach(), entries(),
 * keys(), values(), and iteration.
 */
function makeHeaders(raw: Record<string, string>): Headers {
	// Normalize keys to lowercase for case-insensitive lookup
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		normalized[key.toLowerCase()] = value;
	}

	return {
		get(name: string): string | null {
			return normalized[name.toLowerCase()] ?? null;
		},
		has(name: string): boolean {
			return name.toLowerCase() in normalized;
		},
		forEach(callback: (value: string, key: string, parent: Headers) => void, thisArg?: any): void {
			for (const [key, value] of Object.entries(normalized)) {
				callback.call(thisArg, value, key, this as unknown as Headers);
			}
		},
		entries(): IterableIterator<[string, string]> {
			return Object.entries(normalized)[Symbol.iterator]() as IterableIterator<[string, string]>;
		},
		keys(): IterableIterator<string> {
			return Object.keys(normalized)[Symbol.iterator]() as IterableIterator<string>;
		},
		values(): IterableIterator<string> {
			return Object.values(normalized)[Symbol.iterator]() as IterableIterator<string>;
		},
		[Symbol.iterator](): IterableIterator<[string, string]> {
			return Object.entries(normalized)[Symbol.iterator]() as IterableIterator<[string, string]>;
		},
		// append/delete/set — no-ops since we build from a finished response
		append() {},
		delete() {},
		set() {},
		getSetCookie(): string[] { return []; },
	} as unknown as Headers;
}

/**
 * Custom fetch implementation using Obsidian's requestUrl API.
 * This is required for mobile compatibility since Obsidian mobile
 * does not support Node.js built-ins or native fetch properly.
 *
 * Returns a Response-compatible object with all methods the Supabase
 * JS SDK may call internally: json(), text(), arrayBuffer(), blob(),
 * clone(), plus proper headers, body, and status fields.
 */
const customFetch = async (
	url: string,
	options: RequestInit = {}
): Promise<Response> => {
	// Resolve body: Blob and ArrayBuffer must be passed as raw binary,
	// not JSON-stringified, otherwise storage uploads break.
	let body: string | ArrayBuffer | undefined;
	if (options.body instanceof Blob) {
		body = await options.body.arrayBuffer();
	} else if (options.body instanceof ArrayBuffer) {
		body = options.body;
	} else if (typeof options.body === "string") {
		body = options.body;
	} else if (options.body) {
		body = JSON.stringify(options.body);
	}

	console.log(`[supabase-sync] Fetching: ${url}`);
	const requestHeaders: Record<string, string> = {};
	if (options.headers) {
		if (typeof (options.headers as any).forEach === "function") {
			(options.headers as any).forEach((value: string, key: string) => {
				requestHeaders[key] = value;
			});
		} else if (Array.isArray(options.headers)) {
			for (const [key, value] of options.headers) {
				requestHeaders[key] = value;
			}
		} else {
			for (const [key, value] of Object.entries(options.headers)) {
				requestHeaders[key] = String(value);
			}
		}
	}
	console.log(`[supabase-sync] Request headers keys:`, Object.keys(requestHeaders));

	const response = await requestUrl({
		url,
		method: (options.method as string) || "GET",
		headers: requestHeaders,
		body,
	});

	const headers = makeHeaders(response.headers);
	const ok = response.status >= 200 && response.status < 300;

	// Build a full Response-compatible object
	const result = {
		ok,
		status: response.status,
		statusText: statusTextFromCode(response.status),
		headers,
		url,
		redirected: false,
		type: "basic" as ResponseType,
		body: null as ReadableStream<Uint8Array> | null,
		bodyUsed: false,

		json: async () => response.json,
		text: async () => response.text,
		arrayBuffer: async () => response.arrayBuffer,

		blob: async () => {
			return new Blob([response.arrayBuffer]);
		},

		formData: async () => {
			throw new Error("formData() is not supported in customFetch");
		},

		clone: () => {
			// Return a new object with independent headers (deep copy)
			return { ...result, bodyUsed: false, headers: makeHeaders(response.headers) } as unknown as Response;
		},
	};

	return result as unknown as Response;
};

/**
 * Creates and returns a Supabase client configured for use inside Obsidian.
 * Uses custom fetch for mobile compat and disables session persistence
 * since we authenticate with the service_role key.
 */
export function createSupabaseClient(
	supabaseUrl: string,
	serviceRoleKey: string
): SupabaseClient {
	return createClient(supabaseUrl, serviceRoleKey, {
		global: { fetch: customFetch as unknown as typeof fetch },
		auth: { persistSession: false, autoRefreshToken: false },
	});
}

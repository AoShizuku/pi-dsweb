/**
 * DeepSeek Search & Fetch API client.
 *
 * Follows https://api-docs.deepseek.com/zh-cn/guides/search,
 * https://api-docs.deepseek.com/zh-cn/api/search and
 * https://api-docs.deepseek.com/zh-cn/api/fetch:
 *
 * - `POST {base}/v1/tools/search` and `POST {base}/v1/tools/fetch`, Bearer auth.
 * - Search: `query` 1–128 Unicode characters (operators included), `count` 1–50
 *   (default 10, does not affect price), optional `ori_question` (1–128 chars),
 *   `need_content` (default false).
 * - Fetch: `url` 1–8192 chars, http(s) with a host and no credentials.
 * - Errors use the OpenAI shape `{ error: { message, type, param, code } }`.
 *   408, 429 and 5xx are worth retrying after a wait; other 4xx are not.
 * - Account limits: Search 100 QPS, Fetch 25 QPS, plus an undisclosed
 *   per-target-domain limit on Fetch. All return 429.
 */

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const SEARCH_PATH = "/v1/tools/search";
export const FETCH_PATH = "/v1/tools/fetch";

export const MAX_QUERY_CHARS = 128;
export const MAX_QUESTION_CHARS = 128;
export const DEFAULT_COUNT = 10;
export const MAX_COUNT = 50;
export const MAX_URL_LENGTH = 8192;

/** The docs give no server timeout; these bound one attempt, not the whole call. */
const DEFAULT_TIMEOUT_MS: Record<Endpoint, number> = { search: 30_000, fetch: 60_000 };
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_AFTER_MS = 10_000;

export type Endpoint = "search" | "fetch";

/** One item of the Search response, with `null`/missing fields normalized. */
export interface SearchResult {
	/** 0–3, combines relevance, authority and freshness; >= 1.5 is high quality. */
	rerankScore: number | null;
	title: string;
	url: string;
	/** 100–200 chars, meant for display. */
	snippet: string;
	/** 600–800 chars, meant for the model. */
	summary: string;
	/** Page body; empty unless `need_content` was true. */
	content: string;
	siteName: string | null;
	siteIcon: string | null;
	/** RFC 3339 UTC publish time, or null when unknown. */
	date: string | null;
	/** -1 (unknown) to 4; >= 3 is very authoritative. */
	authority: number | null;
}

export interface FetchResult {
	title: string;
	/** Page body as Markdown. */
	content: string;
}

export interface SearchRequest {
	query: string;
	count?: number;
	/** The user's original question, sent as `ori_question` to help intent. */
	question?: string;
	includeContent?: boolean;
}

export interface ClientOptions {
	apiKey: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	/** Retries after the first attempt for 408 / 429 / 5xx / network errors. */
	maxRetries?: number;
	/** Base backoff; doubles per retry unless the server sends Retry-After. */
	retryDelayMs?: number;
	timeoutMs?: number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class DeepSeekToolError extends Error {
	readonly endpoint: Endpoint;
	readonly status: number | undefined;

	constructor(message: string, endpoint: Endpoint, status?: number) {
		super(message);
		this.name = "DeepSeekToolError";
		this.endpoint = endpoint;
		this.status = status;
	}
}

const LABEL: Record<Endpoint, string> = { search: "Search", fetch: "Fetch" };

// ---------------------------------------------------------------- validation

export function validateQuery(query: string): string {
	const trimmed = (query ?? "").trim();
	if (!trimmed) throw new DeepSeekToolError("query must not be empty.", "search");
	const length = [...trimmed].length;
	if (length > MAX_QUERY_CHARS) {
		throw new DeepSeekToolError(
			`query is ${length} characters (operators included); DeepSeek Search accepts at most ${MAX_QUERY_CHARS}. Shorten it.`,
			"search",
		);
	}
	return trimmed;
}

export function validateCount(count: number | undefined): number {
	if (count === undefined) return DEFAULT_COUNT;
	if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
		throw new DeepSeekToolError(`count must be an integer between 1 and ${MAX_COUNT}.`, "search");
	}
	return count;
}

/** `ori_question` is only a hint, so an over-long one is clipped instead of rejected. */
export function clipQuestion(question: string | undefined): string | undefined {
	const trimmed = (question ?? "").trim();
	if (!trimmed) return undefined;
	const chars = [...trimmed];
	return chars.length > MAX_QUESTION_CHARS ? chars.slice(0, MAX_QUESTION_CHARS).join("") : trimmed;
}

export function validateFetchUrl(raw: string): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) throw new DeepSeekToolError("url must not be empty.", "fetch");
	if (trimmed.length > MAX_URL_LENGTH) {
		throw new DeepSeekToolError(`url is longer than ${MAX_URL_LENGTH} characters.`, "fetch");
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new DeepSeekToolError(`"${trimmed}" is not a valid URL.`, "fetch");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new DeepSeekToolError("url must use http or https.", "fetch");
	}
	if (!parsed.hostname) throw new DeepSeekToolError("url must include a host.", "fetch");
	if (parsed.username || parsed.password) {
		throw new DeepSeekToolError("url must not contain a username or password.", "fetch");
	}
	return trimmed;
}

// ------------------------------------------------------------------- parsing

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseSearchResults(data: unknown): SearchResult[] {
	const results = data && typeof data === "object" ? (data as { results?: unknown }).results : undefined;
	if (!Array.isArray(results)) {
		throw new DeepSeekToolError("DeepSeek Search returned an unexpected response (no results array).", "search");
	}
	const parsed: SearchResult[] = [];
	for (const item of results) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const url = str(record.url).trim();
		if (!url) continue;
		parsed.push({
			rerankScore: num(record.rerank_score),
			title: str(record.title).trim(),
			url,
			snippet: str(record.snippet).trim(),
			summary: str(record.summary).trim(),
			content: str(record.content),
			siteName: nullableStr(record.site_name),
			siteIcon: nullableStr(record.site_icon),
			date: nullableStr(record.date),
			authority: num(record.authority),
		});
	}
	return parsed;
}

export function parseFetchResult(data: unknown): FetchResult {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new DeepSeekToolError("DeepSeek Fetch returned an unexpected response.", "fetch");
	}
	const record = data as Record<string, unknown>;
	return { title: str(record.title).trim(), content: str(record.content) };
}

// -------------------------------------------------------------------- errors

/**
 * The docs say 408 / 429 / 5xx may be retried after a wait. Fetch's 504 is the
 * exception: it means the target page timed out (about 30s server-side, e.g. a
 * large PDF), and asking again for the same URL just times out again.
 */
export function isRetryableStatus(status: number, endpoint: Endpoint): boolean {
	if (endpoint === "fetch" && status === 504) return false;
	return status === 408 || status === 429 || status >= 500;
}

export function describeStatus(endpoint: Endpoint, status: number, detail: string): string {
	const label = LABEL[endpoint];
	const suffix = detail ? `: ${detail}` : "";
	switch (status) {
		case 400:
			return `DeepSeek ${label} rejected the request (400)${suffix}`;
		case 401:
			return `DeepSeek API key is missing or invalid (401). Set DEEPSEEK_API_KEY or run /login and pick DeepSeek.${detail ? ` Detail: ${detail}` : ""}`;
		case 402:
			return "DeepSeek account balance is insufficient (402). Top up at https://platform.deepseek.com and retry.";
		case 403:
			return `DeepSeek Fetch refused this URL under its security policy (403)${suffix}`;
		case 404:
			if (endpoint === "fetch") {
				return (
					"DeepSeek Fetch could not get usable content (404): the page may be unavailable, blocked by the site, " +
					`returning an error, an unsupported content type, or have no extractable body${detail ? `. Detail: ${detail}` : "."}`
				);
			}
			return `DeepSeek ${label} endpoint not found (404)${suffix}`;
		case 408:
			return `DeepSeek ${label} timed out reading the request (408); retries were exhausted${suffix}`;
		case 413:
			return `DeepSeek ${label} request body is too large (413)${suffix}`;
		case 429:
			return endpoint === "fetch"
				? "DeepSeek Fetch is rate limited (429) and retries were exhausted. Fetch also limits requests per target domain: wait before fetching more pages from the same site."
				: "DeepSeek Search is rate limited (429) and retries were exhausted. Wait and retry.";
		case 504:
			return endpoint === "fetch"
				? `DeepSeek Fetch timed out loading the page (504); it may be too slow or too large (e.g. a big PDF)${suffix}`
				: `DeepSeek ${label} timed out downstream (504); retries were exhausted${suffix}`;
		default:
			if (status >= 500) return `DeepSeek ${label} server error (${status}); retries were exhausted${suffix}`;
			return `DeepSeek ${label} error (${status})${suffix}`;
	}
}

async function readErrorDetail(response: Response, apiKey: string): Promise<string> {
	const text = await response.text().catch(() => "");
	let detail = "";
	try {
		const message = (JSON.parse(text) as { error?: { message?: unknown } })?.error?.message;
		if (typeof message === "string") detail = message.trim();
	} catch {
		// Not JSON: fall back to the raw body.
	}
	if (!detail) detail = text.trim().slice(0, 300);
	return apiKey ? detail.split(apiKey).join("***") : detail;
}

// ------------------------------------------------------------------ requests

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function retryDelay(response: Response | undefined, attempt: number, baseMs: number): number {
	const header = response?.headers.get("retry-after");
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
		const at = Date.parse(header);
		if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
	}
	return baseMs * 2 ** attempt;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as { cause?: unknown }).cause;
		return cause instanceof Error && cause.message ? `${error.message} (${cause.message})` : error.message;
	}
	return String(error);
}

async function post(
	options: ClientOptions,
	endpoint: Endpoint,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	const doFetch = options.fetchImpl ?? fetch;
	const sleep = options.sleep ?? abortableSleep;
	const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const url = base + (endpoint === "search" ? SEARCH_PATH : FETCH_PATH);
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS[endpoint];
	const label = LABEL[endpoint];

	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		const timeout = AbortSignal.timeout(timeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

		let response: Response;
		try {
			response = await doFetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(body),
				signal: requestSignal,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			if (attempt < maxRetries) {
				await sleep(retryDelay(undefined, attempt, baseDelay), signal);
				continue;
			}
			if (timeout.aborted) {
				throw new DeepSeekToolError(`DeepSeek ${label} timed out after ${Math.round(timeoutMs / 1000)}s.`, endpoint);
			}
			throw new DeepSeekToolError(`DeepSeek ${label} request failed: ${errorMessage(error)}`, endpoint);
		}

		if (response.ok) {
			try {
				return await response.json();
			} catch (error) {
				if (signal?.aborted) throw error;
				throw new DeepSeekToolError(`DeepSeek ${label} returned invalid JSON: ${errorMessage(error)}`, endpoint);
			}
		}

		if (isRetryableStatus(response.status, endpoint) && attempt < maxRetries) {
			await response.body?.cancel().catch(() => {});
			await sleep(retryDelay(response, attempt, baseDelay), signal);
			continue;
		}

		const detail = await readErrorDetail(response, options.apiKey);
		throw new DeepSeekToolError(describeStatus(endpoint, response.status, detail), endpoint, response.status);
	}
}

export async function search(options: ClientOptions, request: SearchRequest, signal?: AbortSignal): Promise<SearchResult[]> {
	const body: Record<string, unknown> = {
		query: validateQuery(request.query),
		count: validateCount(request.count),
	};
	const question = clipQuestion(request.question);
	if (question) body.ori_question = question;
	if (request.includeContent) body.need_content = true;
	return parseSearchResults(await post(options, "search", body, signal));
}

export async function fetchPage(options: ClientOptions, url: string, signal?: AbortSignal): Promise<FetchResult> {
	const target = validateFetchUrl(url);
	const page = parseFetchResult(await post(options, "fetch", { url: target }, signal));
	if (!page.content.trim()) {
		throw new DeepSeekToolError("DeepSeek Fetch returned no content for this URL.", "fetch", 200);
	}
	return page;
}

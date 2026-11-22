import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { type ClientOptions, fetchPage, MAX_COUNT, MAX_QUERY_CHARS, search } from "./client.js";
import { formatDate, formatFetchedPage, formatSearchResults, hostOf, SEARCH_CONTENT_CHAR_LIMIT } from "./format.js";
import { createRowRenderers } from "./render.js";
import { createSettings } from "./settings.js";
import { exposeSettings } from "./shizuku-settings.js";

/**
 * pi-dsweb — `web_search` and `web_fetch` backed by DeepSeek's official Search &
 * Fetch API (https://api-docs.deepseek.com/zh-cn/guides/search). Billed per
 * successful request (5 CNY / 1000 for each API); empty results, failures and
 * timeouts are free. Works with any conversation model: only a DeepSeek API key
 * is needed.
 */

export const WEB_SEARCH_TOOL = "web_search";
export const WEB_FETCH_TOOL = "web_fetch";
export const DEEPSEEK_PROVIDER = "deepseek";

const EXPANDED_FETCH_PREVIEW_LINES = 40;

export const NO_API_KEY_MESSAGE =
	"No DeepSeek API key found. Set the DEEPSEEK_API_KEY environment variable, or run /login in pi and pick DeepSeek.";

// --------------------------------------------------------------------- schema

export const WebSearchParams = Type.Object({
	query: Type.String({
		description:
			`Search query, at most ${MAX_QUERY_CHARS} characters including operators. Operators can be combined: ` +
			'site:a.com OR site:b.com, -site:x.com, -word, "exact phrase", -"phrase", lang:zh,en, after:2025-01-01, before:2026.',
	}),
	count: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_COUNT,
			description: `Number of results, 1-${MAX_COUNT} (default 10). The price is per request, not per result.`,
		}),
	),
	question: Type.Optional(
		Type.String({
			description:
				"The user's original question in natural language (at most 128 characters). Helps rank results by intent.",
		}),
	),
	include_content: Type.Optional(
		Type.Boolean({
			description:
				`Also return each result's page body (up to ${SEARCH_CONTENT_CHAR_LIMIT} characters each in the output; ` +
				"the full text is saved to a file). Off by default; prefer web_fetch to read one or two pages.",
		}),
	),
});
export type WebSearchInput = Static<typeof WebSearchParams>;

export const WebFetchParams = Type.Object({
	url: Type.String({ description: "The http(s) URL of the page to read." }),
});
export type WebFetchInput = Static<typeof WebFetchParams>;

// -------------------------------------------------------------------- details

export interface SearchHit {
	title: string;
	url: string;
	date: string;
}

export interface SearchDetails {
	kind: "search";
	query: string;
	results: SearchHit[];
	fullOutputPath?: string;
}

export interface FetchDetails {
	kind: "fetch";
	url: string;
	title: string;
	lines: number;
	bytes: number;
	truncated: boolean;
	fullOutputPath?: string;
}

// --------------------------------------------------------------- dependencies

export interface DsWebDeps {
	/** Overrides how the API key is found; tests use it. */
	resolveApiKey?: (ctx: ExtensionContext) => Promise<string | undefined>;
	/** Extra client options (base URL, fetch implementation, retry timing). */
	client?: Omit<ClientOptions, "apiKey">;
	/** Saves an over-long output and returns its path, or undefined when it could not. */
	saveFullOutput?: (kind: "search" | "fetch", text: string) => Promise<string | undefined>;
}

/** pi's own DeepSeek credentials (/login, auth.json, provider env) first, then DEEPSEEK_API_KEY. */
export async function resolveApiKey(ctx: ExtensionContext): Promise<string | undefined> {
	try {
		const key = (await ctx.modelRegistry.getApiKeyForProvider(DEEPSEEK_PROVIDER))?.trim();
		if (key) return key;
	} catch {
		// Fall through to the environment.
	}
	return process.env.DEEPSEEK_API_KEY?.trim() || undefined;
}

export async function saveFullOutput(kind: "search" | "fetch", text: string): Promise<string | undefined> {
	try {
		const dir = join(tmpdir(), "pi-dsweb");
		await mkdir(dir, { recursive: true });
		const file = join(dir, `${kind}-${Date.now()}-${randomBytes(3).toString("hex")}.md`);
		await writeFile(file, text, "utf8");
		return file;
	} catch {
		return undefined;
	}
}

// ------------------------------------------------------------------ rendering

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n")
		.trim();
}


function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** `● Web Search (query) · N results`; the query cut by the row width, `with content` when asked for. */
const searchRow = createRowRenderers({
	title: "Web Search",
	detail: (args) => {
		const query = typeof args.query === "string" && args.query.trim() ? oneLine(args.query) : "…";
		return args.include_content === true ? `${query} · with content` : query;
	},
	running: "Searching…",
	summary: (result, expanded, theme) => {
		const details = result.details as SearchDetails | undefined;
		if (details?.kind !== "search") return [theme.fg("dim", resultText(result).split("\n")[0] ?? "")];
		return searchSummaryLines(details, expanded, theme);
	},
});

/** `● Web Fetch (url) · title · N lines · size`; expanded previews the page. */
const fetchRow = createRowRenderers({
	title: "Web Fetch",
	detail: (args) => (typeof args.url === "string" && args.url.trim() ? args.url.trim() : "…"),
	running: "Fetching…",
	summary: (result, expanded, theme) => {
		const details = result.details as FetchDetails | undefined;
		if (details?.kind !== "fetch") return [theme.fg("dim", resultText(result).split("\n")[0] ?? "")];
		return fetchSummaryLines(details, resultText(result), expanded, theme);
	},
});

export function searchSummaryLines(details: SearchDetails, expanded: boolean, theme: Theme): string[] {
	const count = details.results.length;
	const head = count === 0 ? "No results" : plural(count, "result");
	const saved = details.fullOutputPath ? " · full output saved" : "";
	const lines = [theme.fg("dim", head + saved)];
	if (!expanded) return lines;
	details.results.forEach((hit, index) => {
		const meta = [hostOf(hit.url), hit.date].filter(Boolean).join(" · ");
		lines.push(`${theme.fg("muted", `${index + 1}.`)} ${oneLine(hit.title) || hit.url} ${theme.fg("dim", `— ${meta}`)}`);
	});
	return lines;
}

export function fetchSummaryLines(details: FetchDetails, body: string, expanded: boolean, theme: Theme): string[] {
	const parts = [oneLine(details.title) || hostOf(details.url), plural(details.lines, "line"), formatSize(details.bytes)];
	if (details.truncated) parts.push(details.fullOutputPath ? "truncated, full page saved" : "truncated");
	const lines = [theme.fg("dim", parts.join(" · "))];
	if (!expanded) return lines;
	const bodyLines = body.split("\n");
	lines.push(...bodyLines.slice(0, EXPANDED_FETCH_PREVIEW_LINES).map((line) => theme.fg("toolOutput", line)));
	if (bodyLines.length > EXPANDED_FETCH_PREVIEW_LINES) {
		lines.push(theme.fg("dim", `… ${plural(bodyLines.length - EXPANDED_FETCH_PREVIEW_LINES, "more line")}`));
	}
	return lines;
}

// ---------------------------------------------------------------- extension

function truncationNote(
	truncation: ReturnType<typeof truncateHead>,
	path: string | undefined,
	what: string,
): string {
	const shown =
		`Showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
		`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})`;
	return path
		? `[${shown}. Full ${what} saved to: ${path} — read it with the read tool (use offset to continue).]`
		: `[${shown}. The full ${what} could not be saved.]`;
}

export function registerDsWeb(pi: ExtensionAPI, deps: DsWebDeps = {}): void {
	const getKey = deps.resolveApiKey ?? resolveApiKey;
	const save = deps.saveFullOutput ?? saveFullOutput;

	async function clientOptions(ctx: ExtensionContext): Promise<ClientOptions> {
		const apiKey = await getKey(ctx);
		if (!apiKey) throw new Error(NO_API_KEY_MESSAGE);
		return { ...deps.client, apiKey };
	}

	pi.registerTool({
		name: WEB_SEARCH_TOOL,
		label: "Web Search",
		description:
			"Search the web with DeepSeek's Search API. Returns ranked results with title, URL, site, publish date, " +
			"relevance score (0-3, 1.5 or more is high quality), authority (0-4) and a ~700-character summary of each page. " +
			"The query accepts combinable operators: site:a.com OR site:b.com (restrict to sites), -site:x.com (exclude a site), " +
			'-word, "exact phrase", -"phrase", lang:zh,en, after:2025-01-01, before:2026. ' +
			`The whole query, operators included, must be at most ${MAX_QUERY_CHARS} characters. ` +
			"Use web_fetch to read a result in full.",
		promptSnippet: "Search the web; results carry URL, date and a summary",
		parameters: WebSearchParams,
		annotations: { readOnlyHint: true, openWorldHint: true },
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SearchDetails>> {
			const options = await clientOptions(ctx);
			const query = params.query.trim();
			onUpdate?.({
				content: [{ type: "text", text: `Searching "${query}"…` }],
				details: { kind: "search", query, results: [] },
			});

			const results = await search(
				options,
				{ query, count: params.count, question: params.question, includeContent: params.include_content },
				signal,
			);

			const shown = formatSearchResults(query, results, SEARCH_CONTENT_CHAR_LIMIT);
			const truncation = truncateHead(shown.text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let text = truncation.content;
			let fullOutputPath: string | undefined;
			if (shown.clipped || truncation.truncated) {
				fullOutputPath = await save("search", formatSearchResults(query, results).text);
				text += truncation.truncated
					? `\n\n${truncationNote(truncation, fullOutputPath, "results")}`
					: fullOutputPath
						? `\n\n[Page content was clipped to ${SEARCH_CONTENT_CHAR_LIMIT} characters per result. Full results saved to: ${fullOutputPath}]`
						: `\n\n[Page content was clipped to ${SEARCH_CONTENT_CHAR_LIMIT} characters per result.]`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					kind: "search",
					query,
					results: results.map((r) => ({ title: r.title, url: r.url, date: formatDate(r.date) })),
					...(fullOutputPath ? { fullOutputPath } : {}),
				},
			};
		},
		// Drawn without pi's colored box so it lines up with the compact tool rows.
		renderShell: "self",
		...searchRow,
	});

	pi.registerTool({
		name: WEB_FETCH_TOOL,
		label: "Web Fetch",
		description:
			"Read a public web page with DeepSeek's Fetch API and return its main content as Markdown. http(s) URLs only. " +
			`Output is capped at ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}; a longer page is saved in full ` +
			"to a temp file whose path is returned, so you can read the rest with the read tool. " +
			"Fails for unavailable pages, pages blocked by the site, unsupported content types, or pages without an extractable body.",
		promptSnippet: "Read a web page as Markdown",
		parameters: WebFetchParams,
		annotations: { readOnlyHint: true, openWorldHint: true },
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<FetchDetails>> {
			const options = await clientOptions(ctx);
			const url = params.url.trim();
			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${url}…` }],
				details: { kind: "fetch", url, title: "", lines: 0, bytes: 0, truncated: false },
			});

			const page = await fetchPage(options, url, signal);
			const full = formatFetchedPage(url, page);
			const truncation = truncateHead(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let text = truncation.content;
			let fullOutputPath: string | undefined;
			if (truncation.truncated) {
				fullOutputPath = await save("fetch", full);
				text += `\n\n${truncationNote(truncation, fullOutputPath, "page")}`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					kind: "fetch",
					url,
					title: page.title,
					lines: truncation.totalLines,
					bytes: truncation.totalBytes,
					truncated: truncation.truncated,
					...(fullOutputPath ? { fullOutputPath } : {}),
				},
			};
		},
		renderShell: "self",
		...fetchRow,
	});
}

export default function piDsWeb(pi: ExtensionAPI): void {
	registerDsWeb(pi);
	const settings = createSettings(DEEPSEEK_PROVIDER);
	exposeSettings(pi, settings.provider);
	// Checked again before each run, so a /login during the session shows up in the panel.
	const refresh = (ctx: ExtensionContext) => void settings.refresh(ctx).catch(() => undefined);
	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("before_agent_start", (_event, ctx) => refresh(ctx));
}

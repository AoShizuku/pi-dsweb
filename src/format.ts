import type { FetchResult, SearchResult } from "./client.js";

/** Page body per search result when `include_content` is on; the rest goes to the full-output file. */
export const SEARCH_CONTENT_CHAR_LIMIT = 4_000;

/** `2026-06-01T00:00:00+00:00` → `2026-06-01`; anything unparseable is kept as is. */
export function formatDate(date: string | null): string {
	if (!date) return "";
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(date.trim());
	return match ? match[1]! : date.trim();
}

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function clipChars(text: string, limit: number): { text: string; omitted: number } {
	const chars = [...text];
	if (chars.length <= limit) return { text, omitted: 0 };
	return { text: chars.slice(0, limit).join(""), omitted: chars.length - limit };
}

function metaLine(result: SearchResult): string {
	const parts: string[] = [];
	parts.push(result.siteName?.trim() || hostOf(result.url));
	const date = formatDate(result.date);
	if (date) parts.push(date);
	if (result.rerankScore !== null) parts.push(`score ${result.rerankScore.toFixed(2)}`);
	if (result.authority !== null && result.authority >= 0) parts.push(`authority ${result.authority}`);
	return parts.join(" · ");
}

export interface FormattedSearch {
	text: string;
	/** Whether any result's content was cut at `contentLimit`. */
	clipped: boolean;
}

/**
 * Model-facing search output. `summary` is DeepSeek's text written for models,
 * so it is preferred over the display `snippet`.
 */
export function formatSearchResults(
	query: string,
	results: SearchResult[],
	contentLimit: number = Number.POSITIVE_INFINITY,
): FormattedSearch {
	if (results.length === 0) {
		return { text: `No results for "${query}".`, clipped: false };
	}
	let clipped = false;
	const blocks = results.map((result, index) => {
		const lines = [`[${index + 1}] ${result.title || hostOf(result.url)}`, `URL: ${result.url}`, metaLine(result)];
		const body = result.summary || result.snippet;
		if (body) lines.push(body);
		const content = result.content.trim();
		if (content) {
			const { text, omitted } = clipChars(content, contentLimit);
			if (omitted > 0) clipped = true;
			lines.push("", "Content:", omitted > 0 ? `${text}\n[… ${omitted} more characters]` : text);
		}
		return lines.join("\n");
	});
	const header = `Search results for "${query}" (${results.length}):`;
	return { text: [header, ...blocks].join("\n\n"), clipped };
}

export function formatFetchedPage(url: string, page: FetchResult): string {
	const lines = [];
	if (page.title) lines.push(`Title: ${page.title}`);
	lines.push(`URL: ${url}`, "", page.content.trim());
	return lines.join("\n");
}

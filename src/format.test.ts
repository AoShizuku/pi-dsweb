import { describe, expect, it } from "vitest";

import type { SearchResult } from "./client.js";
import { formatDate, formatFetchedPage, formatSearchResults, hostOf } from "./format.js";

function result(overrides: Partial<SearchResult> = {}): SearchResult {
	return {
		rerankScore: 2.4,
		title: "DeepSeek V4 model released",
		url: "https://www.example.com/deepseek-v4",
		snippet: "short snippet",
		summary: "long summary for models",
		content: "",
		siteName: "Example News",
		siteIcon: null,
		date: "2026-06-01T00:00:00+00:00",
		authority: 3,
		...overrides,
	};
}

describe("formatDate / hostOf", () => {
	it("keeps only the calendar date", () => {
		expect(formatDate("2026-06-01T00:00:00+00:00")).toBe("2026-06-01");
		expect(formatDate(null)).toBe("");
		expect(formatDate("yesterday")).toBe("yesterday");
	});

	it("strips www from hosts", () => {
		expect(hostOf("https://www.example.com/a")).toBe("example.com");
		expect(hostOf("nonsense")).toBe("nonsense");
	});
});

describe("formatSearchResults", () => {
	it("prefers summary over snippet and shows site, date, score and authority", () => {
		const { text, clipped } = formatSearchResults("q", [result()]);
		expect(clipped).toBe(false);
		expect(text).toBe(
			[
				'Search results for "q" (1):',
				"",
				"[1] DeepSeek V4 model released",
				"URL: https://www.example.com/deepseek-v4",
				"Example News · 2026-06-01 · score 2.40 · authority 3",
				"long summary for models",
			].join("\n"),
		);
	});

	it("falls back to snippet, host and skips unknown fields", () => {
		const { text } = formatSearchResults("q", [
			result({ summary: "", siteName: null, date: null, rerankScore: null, authority: -1 }),
		]);
		expect(text).toContain("\nexample.com\nshort snippet");
		expect(text).not.toContain("authority");
	});

	it("clips page content per result and reports it", () => {
		const { text, clipped } = formatSearchResults("q", [result({ content: "abcdef" })], 4);
		expect(clipped).toBe(true);
		expect(text).toContain("Content:\nabcd\n[… 2 more characters]");
		expect(formatSearchResults("q", [result({ content: "abcdef" })]).text).toContain("Content:\nabcdef");
	});

	it("says when nothing matched", () => {
		expect(formatSearchResults("q", []).text).toBe('No results for "q".');
	});
});

describe("formatFetchedPage", () => {
	it("puts title and URL above the Markdown", () => {
		expect(formatFetchedPage("https://e.com", { title: "T", content: "# T\n\nbody\n" })).toBe(
			"Title: T\nURL: https://e.com\n\n# T\n\nbody",
		);
		expect(formatFetchedPage("https://e.com", { title: "", content: "body" })).toBe("URL: https://e.com\n\nbody");
	});
});

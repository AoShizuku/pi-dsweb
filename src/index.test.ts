import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
	type DsWebDeps,
	type FetchDetails,
	NO_API_KEY_MESSAGE,
	type SearchDetails,
	WEB_FETCH_TOOL,
	WEB_SEARCH_TOOL,
	fetchSummaryLines,
	registerDsWeb,
	resolveApiKey,
	searchSummaryLines,
} from "./index.js";

type AnyTool = ToolDefinition<any, any, any>;

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function setup(responses: Response[], deps: Partial<DsWebDeps> = {}) {
	const tools = new Map<string, AnyTool>();
	const pi = { registerTool: (tool: AnyTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
	const queue = [...responses];
	const fetchImpl = vi.fn(async () => {
		const next = queue.shift();
		if (!next) throw new Error("unexpected request");
		return next;
	});
	const saveFullOutput = vi.fn(async (kind: "search" | "fetch", _text: string) => `/tmp/pi-dsweb/${kind}.md`);
	registerDsWeb(pi, {
		resolveApiKey: async () => "sk-test",
		client: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
		saveFullOutput,
		...deps,
	});
	const ctx = {} as ExtensionContext;
	const run = (name: string, params: unknown) => tools.get(name)!.execute("call-1", params, undefined, undefined, ctx as never);
	return { tools, run, fetchImpl, saveFullOutput };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

function sentBody(fetchImpl: ReturnType<typeof setup>["fetchImpl"]): unknown {
	const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
	return JSON.parse(String(init.body));
}

const HIT = {
	rerank_score: 2,
	title: "Hit",
	url: "https://example.com/a",
	snippet: "s",
	summary: "summary",
	content: "",
	site_name: "Example",
	site_icon: null,
	date: "2026-06-01T00:00:00+00:00",
	authority: 2,
};

describe("registration", () => {
	it("registers read-only web_search and web_fetch tools", () => {
		const { tools } = setup([]);
		expect([...tools.keys()]).toEqual([WEB_SEARCH_TOOL, WEB_FETCH_TOOL]);
		for (const tool of tools.values()) {
			expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
			expect(tool.promptSnippet).toBeTruthy();
		}
		expect(tools.get(WEB_SEARCH_TOOL)!.description).toContain("site:a.com OR site:b.com");
	});
});

describe("api key", () => {
	it("fails clearly without a key", async () => {
		const { run, fetchImpl } = setup([], { resolveApiKey: async () => undefined });
		await expect(run(WEB_SEARCH_TOOL, { query: "q" })).rejects.toThrow(NO_API_KEY_MESSAGE);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("prefers pi's deepseek credentials, then DEEPSEEK_API_KEY", async () => {
		const withLogin = { modelRegistry: { getApiKeyForProvider: async () => "sk-login" } } as unknown as ExtensionContext;
		expect(await resolveApiKey(withLogin)).toBe("sk-login");

		const previous = process.env.DEEPSEEK_API_KEY;
		process.env.DEEPSEEK_API_KEY = "sk-env";
		try {
			const withoutLogin = { modelRegistry: { getApiKeyForProvider: async () => undefined } } as unknown as ExtensionContext;
			expect(await resolveApiKey(withoutLogin)).toBe("sk-env");
		} finally {
			if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
			else process.env.DEEPSEEK_API_KEY = previous;
		}
	});
});

describe("web_search", () => {
	it("returns formatted results and compact details", async () => {
		const { run, fetchImpl, saveFullOutput } = setup([json({ results: [HIT] })]);
		const result = await run(WEB_SEARCH_TOOL, { query: " DeepSeek ", count: 3 });

		expect(sentBody(fetchImpl)).toEqual({ query: "DeepSeek", count: 3 });
		expect(textOf(result)).toContain("[1] Hit\nURL: https://example.com/a");
		expect(result.details).toEqual({
			kind: "search",
			query: "DeepSeek",
			results: [{ title: "Hit", url: "https://example.com/a", date: "2026-06-01" }],
		});
		expect(saveFullOutput).not.toHaveBeenCalled();
	});

	it("saves the full output when page content was clipped", async () => {
		const { run, saveFullOutput } = setup([json({ results: [{ ...HIT, content: "x".repeat(5000) }] })]);
		const result = await run(WEB_SEARCH_TOOL, { query: "q", include_content: true });

		expect(saveFullOutput).toHaveBeenCalledTimes(1);
		expect(saveFullOutput.mock.calls[0]![1]).toContain("x".repeat(5000));
		expect(textOf(result)).toContain("Full results saved to: /tmp/pi-dsweb/search.md");
		expect(result.details.fullOutputPath).toBe("/tmp/pi-dsweb/search.md");
	});
});

describe("web_fetch", () => {
	it("returns the page Markdown with title and URL", async () => {
		const { run } = setup([json({ title: "T", content: "# T\n\nbody" })]);
		const result = await run(WEB_FETCH_TOOL, { url: "https://example.com/a" });
		expect(textOf(result)).toBe("Title: T\nURL: https://example.com/a\n\n# T\n\nbody");
		expect(result.details).toMatchObject({ kind: "fetch", title: "T", truncated: false });
	});

	it("truncates long pages and points to the saved full page", async () => {
		const content = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
		const { run, saveFullOutput } = setup([json({ title: "Long", content })]);
		const result = await run(WEB_FETCH_TOOL, { url: "https://example.com/long" });

		expect(saveFullOutput).toHaveBeenCalledWith("fetch", expect.stringContaining("line 2499"));
		expect(textOf(result)).not.toContain("line 2499");
		expect(textOf(result)).toMatch(/Full page saved to: \/tmp\/pi-dsweb\/fetch\.md/);
		expect(result.details).toMatchObject({ truncated: true, fullOutputPath: "/tmp/pi-dsweb/fetch.md" });
	});

	it("rejects non-http URLs before calling the API", async () => {
		const { run, fetchImpl } = setup([]);
		await expect(run(WEB_FETCH_TOOL, { url: "file:///etc/passwd" })).rejects.toThrow(/http or https/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("rendering", () => {
	it("summarizes search results in one line, listing them when expanded", () => {
		const details: SearchDetails = {
			kind: "search",
			query: "q",
			results: [{ title: "Hit", url: "https://www.example.com/a", date: "2026-06-01" }],
		};
		expect(searchSummaryLines(details, false, plainTheme)).toEqual(["1 result"]);
		expect(searchSummaryLines(details, true, plainTheme)).toEqual(["1 result", "1. Hit — example.com · 2026-06-01"]);
	});

	it("summarizes a fetched page and previews it when expanded", () => {
		const details: FetchDetails = {
			kind: "fetch",
			url: "https://example.com/a",
			title: "T",
			lines: 3,
			bytes: 20,
			truncated: false,
		};
		expect(fetchSummaryLines(details, "a\nb", false, plainTheme)).toEqual(["T · 3 lines · 20B"]);
		expect(fetchSummaryLines(details, "a\nb", true, plainTheme)).toEqual(["T · 3 lines · 20B", "a", "b"]);
	});
});

describe("tool rows", () => {
	/** Tags the marker colors so they are visible in assertions. */
	const markerTheme = {
		fg: (color: string, text: string) => (["accent", "success", "error"].includes(color) && text.length === 1 ? `<${color}>${text}` : text),
		bold: (text: string) => text,
	} as unknown as Theme;

	function row(
		name: string,
		args: Record<string, unknown>,
		result?: { text: string; details?: unknown; isError?: boolean; partial?: boolean },
		options: { outputPad?: number; expanded?: boolean } = {},
	): string[] {
		const tool = setup([]).tools.get(name)!;
		expect(tool.renderShell).toBe("self");
		const context = {
			state: {},
			expanded: options.expanded ?? false,
			isError: result?.isError ?? false,
			outputPad: options.outputPad ?? 1,
			lastComponent: undefined,
		} as never;
		const component = tool.renderCall!(args, markerTheme, context);
		if (result) {
			tool.renderResult!(
				{ content: [{ type: "text", text: result.text }], details: result.details },
				{ expanded: options.expanded ?? false, isPartial: result.partial ?? false },
				markerTheme,
				context,
			);
		}
		return component.render(200);
	}

	const search: SearchDetails = { kind: "search", query: "q", results: [{ title: "Hit", url: "https://www.example.com/a", date: "2026-06-01" }] };
	const page: FetchDetails = { kind: "fetch", url: "https://example.com/a", title: "T", lines: 3, bytes: 20, truncated: false };

	it("draws one bash-style line with the marker in column 0, whatever the outputPad", () => {
		expect(row(WEB_SEARCH_TOOL, { query: "vitest  run" })).toEqual(["<accent>● Web Search (vitest run) · Searching…"]);
		expect(row(WEB_SEARCH_TOOL, { query: "q" }, { text: "", details: search }, { outputPad: 2 })).toEqual(["<success>● Web Search (q) · 1 result"]);
		expect(row(WEB_FETCH_TOOL, { url: "https://example.com/a" }, { text: "a\nb", details: page })).toEqual([
			"<success>● Web Fetch (https://example.com/a) · T · 3 lines · 20B",
		]);
	});

	it("indents the expanded lines under the title", () => {
		expect(row(WEB_SEARCH_TOOL, { query: "q" }, { text: "", details: search }, { expanded: true })).toEqual([
			"<success>● Web Search (q) · 1 result",
			"  1. Hit — example.com · 2026-06-01",
		]);
	});

	it("marks a failure red with its first line", () => {
		expect(row(WEB_FETCH_TOOL, { url: "https://example.com/a" }, { text: "HTTP 404\nmore", isError: true })).toEqual([
			"<error>× Web Fetch (https://example.com/a) · HTTP 404",
		]);
	});
});

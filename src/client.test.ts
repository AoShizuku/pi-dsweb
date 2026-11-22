import { describe, expect, it, vi } from "vitest";

import {
	type ClientOptions,
	DeepSeekToolError,
	clipQuestion,
	describeStatus,
	fetchPage,
	parseSearchResults,
	search,
	validateCount,
	validateFetchUrl,
	validateQuery,
} from "./client.js";

const SAMPLE_RESULT = {
	rerank_score: 2.4,
	title: "DeepSeek V4 model released",
	url: "https://example.com/deepseek-v4",
	snippet: "DeepSeek V4 is now available.",
	summary: "DeepSeek has released the V4 model.",
	content: "",
	site_name: "Example News",
	site_icon: "https://example.com/favicon.ico",
	date: "2026-06-01T00:00:00+00:00",
	authority: 3,
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function client(responses: Array<Response | Error>, extra: Partial<ClientOptions> = {}) {
	const queue = [...responses];
	const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
		const next = queue.shift();
		if (!next) throw new Error("unexpected request");
		if (next instanceof Error) throw next;
		return next;
	});
	const sleep = vi.fn(async (_ms: number) => {});
	const options: ClientOptions = {
		apiKey: "sk-test",
		fetchImpl: fetchImpl as unknown as typeof fetch,
		sleep,
		...extra,
	};
	return { options, fetchImpl, sleep };
}

function sentBody(fetchImpl: ReturnType<typeof client>["fetchImpl"], call = 0): Record<string, unknown> {
	const init = fetchImpl.mock.calls[call]?.[1];
	return JSON.parse(String(init?.body));
}

describe("validation", () => {
	it("counts query length in Unicode characters, operators included", () => {
		expect(validateQuery("  深度求索 site:github.com  ")).toBe("深度求索 site:github.com");
		expect(() => validateQuery("字".repeat(129))).toThrow(/129 characters/);
		expect(validateQuery("😀".repeat(128))).toHaveLength(256);
		expect(() => validateQuery("   ")).toThrow(/empty/);
	});

	it("defaults count to 10 and rejects values outside 1-50", () => {
		expect(validateCount(undefined)).toBe(10);
		expect(validateCount(50)).toBe(50);
		expect(() => validateCount(0)).toThrow(DeepSeekToolError);
		expect(() => validateCount(51)).toThrow(DeepSeekToolError);
		expect(() => validateCount(2.5)).toThrow(DeepSeekToolError);
	});

	it("clips an over-long ori_question instead of rejecting it", () => {
		expect(clipQuestion("  ")).toBeUndefined();
		expect([...clipQuestion("问".repeat(200))!]).toHaveLength(128);
	});

	it("accepts only http(s) URLs with a host and no credentials", () => {
		expect(validateFetchUrl(" https://example.com/a ")).toBe("https://example.com/a");
		expect(() => validateFetchUrl("ftp://example.com")).toThrow(/http or https/);
		expect(() => validateFetchUrl("https://user:pw@example.com")).toThrow(/username or password/);
		expect(() => validateFetchUrl("not a url")).toThrow(/not a valid URL/);
		expect(() => validateFetchUrl(`https://example.com/${"a".repeat(8200)}`)).toThrow(/8192/);
	});
});

describe("parseSearchResults", () => {
	it("maps documented fields and normalizes nulls", () => {
		const [result] = parseSearchResults({
			results: [{ ...SAMPLE_RESULT, site_name: null, date: null, authority: -1 }],
		});
		expect(result).toMatchObject({
			rerankScore: 2.4,
			title: "DeepSeek V4 model released",
			url: "https://example.com/deepseek-v4",
			summary: "DeepSeek has released the V4 model.",
			siteName: null,
			date: null,
			authority: -1,
		});
	});

	it("drops entries without a URL and rejects a payload without results", () => {
		expect(parseSearchResults({ results: [{ title: "x" }, null, SAMPLE_RESULT] })).toHaveLength(1);
		expect(parseSearchResults({ results: [] })).toEqual([]);
		expect(() => parseSearchResults({})).toThrow(/no results array/);
	});
});

describe("search", () => {
	it("posts the documented body to /v1/tools/search with Bearer auth", async () => {
		const { options, fetchImpl } = client([json({ results: [SAMPLE_RESULT] })]);
		const results = await search(options, {
			query: "DeepSeek V4 模型 发布",
			count: 5,
			question: "DeepSeek V4 什么时候发布的？",
			includeContent: true,
		});

		expect(results).toHaveLength(1);
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe("https://api.deepseek.com/v1/tools/search");
		expect(init?.method).toBe("POST");
		expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
		expect(sentBody(fetchImpl)).toEqual({
			query: "DeepSeek V4 模型 发布",
			count: 5,
			ori_question: "DeepSeek V4 什么时候发布的？",
			need_content: true,
		});
	});

	it("omits optional fields that were not asked for", async () => {
		const { options, fetchImpl } = client([json({ results: [] })]);
		await search(options, { query: "q" });
		expect(sentBody(fetchImpl)).toEqual({ query: "q", count: 10 });
	});

	it("honours a custom base URL", async () => {
		const { options, fetchImpl } = client([json({ results: [] })], { baseUrl: "https://proxy.local/ds/" });
		await search(options, { query: "q" });
		expect(fetchImpl.mock.calls[0]![0]).toBe("https://proxy.local/ds/v1/tools/search");
	});

	it("retries 429 and 5xx, honouring Retry-After", async () => {
		const { options, fetchImpl, sleep } = client([
			json({ error: { message: "slow down" } }, 429, { "Retry-After": "3" }),
			json({ error: { message: "boom" } }, 500),
			json({ results: [SAMPLE_RESULT] }),
		]);
		const results = await search(options, { query: "q" });
		expect(results).toHaveLength(1);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(sleep.mock.calls.map((call) => call[0])).toEqual([3000, 2000]);
	});

	it("gives up after maxRetries and reports the status", async () => {
		const { options, fetchImpl } = client([
			json({}, 429),
			json({}, 429),
			json({ error: { message: "too many" } }, 429),
		]);
		await expect(search(options, { query: "q" })).rejects.toMatchObject({
			status: 429,
			message: expect.stringMatching(/Search is rate limited/),
		});
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("does not retry other 4xx and surfaces the API error message", async () => {
		const { options, fetchImpl } = client([
			json(
				{ error: { message: "'count' must be between 1 and 50", type: "invalid_request_error", param: null, code: "invalid_request_error" } },
				400,
			),
		]);
		await expect(search(options, { query: "q" })).rejects.toThrow("'count' must be between 1 and 50");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("explains 401 and 402", async () => {
		const unauthorized = client([json({}, 401)]);
		await expect(search(unauthorized.options, { query: "q" })).rejects.toThrow(/DEEPSEEK_API_KEY/);
		const broke = client([json({}, 402)]);
		await expect(search(broke.options, { query: "q" })).rejects.toThrow(/balance is insufficient/);
	});

	it("retries network errors, then reports them", async () => {
		const { options, fetchImpl } = client([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
		await expect(search(options, { query: "q" })).rejects.toThrow(/request failed: fetch failed/);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("redacts the API key from error details", async () => {
		const { options } = client([new Response("bad key sk-test here", { status: 400 })]);
		await expect(search(options, { query: "q" })).rejects.toThrow("bad key *** here");
	});

	it("stops without requesting when already aborted", async () => {
		const { options, fetchImpl } = client([json({ results: [] })]);
		const controller = new AbortController();
		controller.abort();
		await expect(search(options, { query: "q" }, controller.signal)).rejects.toBeDefined();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("validates before sending", async () => {
		const { options, fetchImpl } = client([]);
		await expect(search(options, { query: "x".repeat(200) })).rejects.toThrow(/at most 128/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("fetchPage", () => {
	it("posts the url to /v1/tools/fetch and returns title and Markdown", async () => {
		const { options, fetchImpl } = client([json({ title: "Example article", content: "# Example article\n\nArticle content." })]);
		const page = await fetchPage(options, "https://example.com/article");
		expect(page).toEqual({ title: "Example article", content: "# Example article\n\nArticle content." });
		expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.deepseek.com/v1/tools/fetch");
		expect(sentBody(fetchImpl)).toEqual({ url: "https://example.com/article" });
	});

	it("explains 403 and 404 without retrying", async () => {
		const blocked = client([json({ error: { message: "blocked" } }, 403)]);
		await expect(fetchPage(blocked.options, "https://example.com")).rejects.toThrow(/security policy \(403\): blocked/);
		const missing = client([json({ error: { message: "no content" } }, 404)]);
		await expect(fetchPage(missing.options, "https://example.com")).rejects.toThrow(/unsupported content type/);
		expect(missing.fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("does not retry a Fetch 504 (the target page timed out), but retries other 5xx", async () => {
		const slow = client([json({ error: { message: "Request timeout" } }, 504)]);
		await expect(fetchPage(slow.options, "https://example.com/big.pdf")).rejects.toThrow(/timed out loading the page \(504\)/);
		expect(slow.fetchImpl).toHaveBeenCalledTimes(1);

		const flaky = client([json({}, 502), json({ title: "T", content: "body" })]);
		await expect(fetchPage(flaky.options, "https://example.com")).resolves.toEqual({ title: "T", content: "body" });
		expect(flaky.fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("still retries a Search 504", async () => {
		const { options, fetchImpl } = client([json({}, 504), json({ results: [] })]);
		await expect(search(options, { query: "q" })).resolves.toEqual([]);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("mentions the per-domain limit when Fetch is rate limited", () => {
		expect(describeStatus("fetch", 429, "")).toMatch(/per target domain/);
	});

	it("treats an empty body as a failure", async () => {
		const { options } = client([json({ title: "", content: "  " })]);
		await expect(fetchPage(options, "https://example.com")).rejects.toThrow(/no content/);
	});
});

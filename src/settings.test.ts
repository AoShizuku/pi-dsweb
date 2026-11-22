import { describe, expect, it } from "vitest";

import { createSettings } from "./settings.js";

function registry(key: string | undefined, fail = false) {
	return {
		modelRegistry: {
			getApiKeyForProvider: async () => {
				if (fail) throw new Error("boom");
				return key;
			},
		},
	} as never;
}

describe("settings provider", () => {
	it("shows only where the key comes from, never the key", async () => {
		const settings = createSettings("deepseek", { DEEPSEEK_API_KEY: "sk-env" });
		const value = () => {
			const [item] = settings.provider.items();
			return item?.kind === "info" ? item.value : undefined;
		};
		expect(value()).toBe("checking…");

		await settings.refresh(registry("sk-pi"));
		expect(value()).toBe("configured (pi auth)");

		await settings.refresh(registry(undefined, true));
		expect(value()).toBe("configured (DEEPSEEK_API_KEY)");
		expect(JSON.stringify(settings.provider.items())).not.toContain("sk-");

		const empty = createSettings("deepseek", {});
		await empty.refresh(registry("  "));
		expect(empty.provider.items()[0]).toMatchObject({ id: "apiKey", kind: "info", value: "not configured · /login or set DEEPSEEK_API_KEY" });
		expect(await empty.provider.set("apiKey", "x")).toMatchObject({ ok: false });
	});
});

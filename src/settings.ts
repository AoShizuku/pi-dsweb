// The pi-dsweb page of the /shizuku settings panel. The API key never shows here and is never written by this
// plugin: the page only says whether one is configured, and where it comes from.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SettingItem, SettingsProvider } from "./shizuku-settings.js";

export type KeySource = "pi" | "env" | undefined;

type KeyContext = Pick<ExtensionContext, "modelRegistry">;

/** Same order as resolveApiKey: pi's own DeepSeek credentials first, then DEEPSEEK_API_KEY. */
export async function keySource(ctx: KeyContext, provider: string, env: Record<string, string | undefined> = process.env): Promise<KeySource> {
	try {
		if ((await ctx.modelRegistry.getApiKeyForProvider(provider))?.trim()) return "pi";
	} catch {
		// Fall through to the environment.
	}
	return env.DEEPSEEK_API_KEY?.trim() ? "env" : undefined;
}

export function keyStatusText(source: KeySource | "checking"): string {
	if (source === "checking") return "checking…";
	if (source === "pi") return "configured (pi auth)";
	if (source === "env") return "configured (DEEPSEEK_API_KEY)";
	return "not configured · /login or set DEEPSEEK_API_KEY";
}

export interface DsWebSettings {
	provider: SettingsProvider;
	/** Re-check where the key comes from; items() is synchronous, so the answer is cached. */
	refresh(ctx: KeyContext): Promise<void>;
}

export function createSettings(deepseekProvider: string, env: Record<string, string | undefined> = process.env): DsWebSettings {
	let status: KeySource | "checking" = "checking";
	return {
		provider: {
			id: "pi-dsweb",
			title: "pi-dsweb",
			description: "web_search / web_fetch through DeepSeek's Search & Fetch API",
			items(): SettingItem[] {
				return [
					{
						id: "apiKey",
						kind: "info",
						label: "DeepSeek API key",
						description: "Taken from pi's DeepSeek credentials (/login, auth.json) first, then DEEPSEEK_API_KEY. Not stored by this plugin.",
						value: keyStatusText(status),
					},
				];
			},
			set: (id) => ({ ok: false, error: `${id} is read-only` }),
		},
		async refresh(ctx) {
			status = await keySource(ctx, deepseekProvider, env);
		},
	};
}

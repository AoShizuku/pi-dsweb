// Tool rows for web_search / web_fetch, drawn with renderShell: "self" so they line up with pi's
// compact tool rows instead of sitting in a colored box:
//
//   ● Web Search (vitest run 单文件) · 5 results
//   ● Web Fetch (https://vitest.dev/guide/cli.html) · Vitest · 1328 lines · 38.1KB
//
// renderCall returns one long-lived component that reads the shared renderer state at render time;
// renderResult only records the latest result there, because the marker color depends on the result
// and pi rebuilds the call component before the result one.

import type { AgentToolResult, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;

export interface RowSpec {
	title: string;
	/** The text in parentheses after the title, from the call arguments. */
	detail: (args: Record<string, unknown>) => string;
	/** Summary shown while the call runs. */
	running: string;
	/** Themed lines for a finished result: the first is the header summary, the rest show when expanded. */
	summary: (result: AgentToolResult<unknown>, expanded: boolean, theme: Theme) => string[];
}

interface RowResult {
	result: AgentToolResult<unknown>;
	isError: boolean;
	partial: boolean;
}

interface RowState {
	row?: WebRow;
	result?: RowResult;
}

const EMPTY: Component = { render: () => [], invalidate: () => {} };

/** Gutter convention (pi-shizuku README.md): markers sit in column 0, so rows ignore pi's outputPad. */
const MARKER_COLUMN = 0;

function firstLine(result: AgentToolResult<unknown>): string {
	const text = result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n")
		.trim();
	return text.split("\n")[0] ?? "";
}

export class WebRow implements Component {
	args: Record<string, unknown> = {};
	theme: Theme | undefined;
	expanded = false;
	pad = 0;

	constructor(
		private readonly spec: RowSpec,
		private readonly state: RowState,
	) {}

	render(width: number): string[] {
		const theme = this.theme;
		if (!theme || width <= 0) return [];
		const pad = " ".repeat(this.pad);
		const current = this.state.result;
		const detail = this.spec.detail(this.args);
		const title = theme.fg("toolTitle", theme.bold(this.spec.title));
		const detailText = detail ? ` ${theme.fg("muted", `(${detail})`)}` : "";

		let marker: string;
		let summary: string;
		let body: string[] = [];
		if (!current || current.partial) {
			marker = theme.fg("accent", "●");
			summary = theme.fg("dim", this.spec.running);
		} else if (current.isError) {
			marker = theme.fg("error", "×");
			summary = theme.fg("error", firstLine(current.result) || "Failed");
		} else {
			marker = theme.fg("success", "●");
			const lines = this.spec.summary(current.result, this.expanded, theme);
			summary = lines[0] ?? "";
			body = lines.slice(1);
		}

		const separator = summary ? theme.fg("dim", " · ") : "";
		const lines = [truncateToWidth(`${pad}${marker} ${title}${detailText}${separator}${summary}`, width, "…")];
		for (const line of body) lines.push(truncateToWidth(`${pad}  ${line}`, width, "…"));
		return lines;
	}

	invalidate(): void {
		// Everything is derived from the shared state at render time.
	}
}

export function createRowRenderers(spec: RowSpec): { renderCall: RenderCall; renderResult: RenderResult } {
	return {
		renderCall(args, theme, context) {
			const state = context.state as RowState;
			const row = state.row ?? new WebRow(spec, state);
			state.row = row;
			row.args = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
			row.theme = theme;
			row.expanded = context.expanded;
			row.pad = MARKER_COLUMN;
			return row;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as RowState;
			state.result = { result: result as AgentToolResult<unknown>, isError: context.isError, partial: options.isPartial };
			if (state.row) {
				state.row.theme = theme;
				state.row.expanded = options.expanded;
				state.row.pad = MARKER_COLUMN;
			}
			return EMPTY;
		},
	};
}

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface StructuredSearchArgs {
	query?: string;
	exactPhrases?: string[];
	excludeTerms?: string[];
	site?: string;
	count?: number;
}

interface BuiltSearchQuery {
	query: string;
	displayQuery: string;
	baseQuery?: string;
	exactPhrases: string[];
	excludeTerms: string[];
	site?: string;
}

interface TavilySearchResponse {
	results?: Array<{
		title: string;
		url: string;
		content?: string;
		score?: number;
	}>;
}

async function tavilySearch(
	query: string,
	count: number,
	apiKey: string,
	site?: string,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const body: {
		query: string;
		search_depth: "basic";
		topic: "general";
		max_results: number;
		include_answer: boolean;
		include_raw_content: boolean;
		include_images: boolean;
		include_domains?: string[];
	} = {
		query,
		search_depth: "basic",
		topic: "general",
		max_results: Math.min(count, 10),
		include_answer: false,
		include_raw_content: false,
		include_images: false,
	};

	// Tavily natively supports restricting results to particular domains.
	// This is preferable to putting site:example.com into the query text.
	if (site) {
		body.include_domains = [site];
	}

	const resp = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!resp.ok) {
		const responseBody = await resp.text();
		throw new Error(
			`Tavily API ${resp.status}: ${responseBody.slice(0, 500)}`,
		);
	}

	const data = (await resp.json()) as TavilySearchResponse;

	if (!data.results || data.results.length === 0) return [];

	return data.results.map((item) => ({
		title: item.title,
		url: item.url,
		snippet: item.content?.replace(/\n/g, " ").trim() ?? "",
	}));
}

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTH_PATH = path.join(EXT_DIR, "auth.json");

function loadApiKey(): string | null {
	// Environment variable takes precedence over auth.json.
	const envApiKey = process.env.TAVILY_API_KEY;
	if (envApiKey) return envApiKey;

	if (!fs.existsSync(AUTH_PATH)) return null;

	try {
		const config = JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
		const apiKey = config.tavily_api_key as string;

		if (apiKey) return apiKey;
	} catch {}

	return null;
}

function formatResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results found.";

	return results
		.map(
			(r, i) =>
				`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
		)
		.join("\n\n");
}

function stripWrappingQuotes(value: string): string {
	return value.length >= 2 &&
		value.startsWith('"') &&
		value.endsWith('"')
		? value.slice(1, -1).trim()
		: value;
}

function cleanItems(values?: string[]): string[] {
	if (!values) return [];

	return values
		.map((value) =>
			stripWrappingQuotes(value.trim().replace(/\s+/g, " ")),
		)
		.filter(Boolean);
}

function cleanQuery(value?: string): string | undefined {
	if (typeof value !== "string") return undefined;

	const cleaned = value.trim().replace(/\s+/g, " ");
	return cleaned || undefined;
}

function normalizeSite(site?: string): string | undefined {
	if (typeof site !== "string") return undefined;

	let value = site.trim().replace(/^site:/i, "").trim();
	if (!value) return undefined;

	try {
		const candidate = /^[a-z]+:\/\//i.test(value)
			? value
			: `https://${value}`;

		const url = new URL(candidate);

		if (url.hostname) {
			value = url.hostname;
		}
	} catch {}

	return value.replace(/\/+$/, "") || undefined;
}

function quoteForSearch(value: string): string {
	return `"${value.replace(/"/g, '\\"')}"`;
}

function buildSearchQuery(
	args: StructuredSearchArgs,
): BuiltSearchQuery {
	const baseQuery = cleanQuery(args.query);
	const exactPhrases = cleanItems(args.exactPhrases);
	const excludeTerms = cleanItems(args.excludeTerms);
	const site = normalizeSite(args.site);

	if (!baseQuery && exactPhrases.length === 0) {
		throw new Error(
			"At least one of 'query' or 'exactPhrases' is required.",
		);
	}

	/*
	 * Keep the same query behavior as the previous Google extension:
	 *
	 *   exactPhrases -> "quoted phrase"
	 *   excludeTerms -> -term or -"multi word term"
	 *
	 * site is handled separately using Tavily's native
	 * include_domains parameter.
	 */
	const parts: string[] = [];

	if (baseQuery) {
		parts.push(baseQuery);
	}

	for (const phrase of exactPhrases) {
		parts.push(quoteForSearch(phrase));
	}

	for (const term of excludeTerms) {
		parts.push(
			`-${term.includes(" ") ? quoteForSearch(term) : term}`,
		);
	}

	const query = parts.join(" ");

	const displayQuery = site
		? `${query} site:${site}`
		: query;

	return {
		query,
		displayQuery,
		baseQuery,
		exactPhrases,
		excludeTerms,
		site,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via Tavily. Build one search per call from a base query string, exact phrases, exclusions, and an optional site. Returns title, URL, and relevant content snippets.",

		promptSnippet:
			"Search the web via Tavily using a query string plus optional exactPhrases, excludeTerms, and site. Use one tool call per search angle.",

		promptGuidelines: [
			"Use exactPhrases for exact phrase matching instead of embedding quote marks inside the main query string.",
			"Use one web_search tool call per search angle instead of batching multiple searches into one call.",
			"Use site when results should be restricted to one specific domain.",
		],

		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Base search query as a normal string. Prefer this for the main search wording.",
				}),
			),

			exactPhrases: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Exact phrases to match. Each item becomes a quoted phrase in the search query.",
				}),
			),

			excludeTerms: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Terms or phrases to exclude. Multi-word items are excluded as quoted phrases.",
				}),
			),

			site: Type.Optional(
				Type.String({
					description:
						"Optional domain restriction, such as example.com or a full URL.",
				}),
			),

			count: Type.Optional(
				Type.Number({
					description:
						"Number of results to return (default: 5, max: 10)",
					minimum: 1,
					maximum: 10,
				}),
			),
		}),

		async execute(
			_toolCallId,
			params: StructuredSearchArgs,
			signal,
		) {
			const apiKey = loadApiKey();

			if (!apiKey) {
				throw new Error(
					`Missing Tavily API key. Set TAVILY_API_KEY or create ${AUTH_PATH} with {"tavily_api_key":"tvly-YOUR_API_KEY"}.`,
				);
			}

			const count = params.count ?? 5;
			const built = buildSearchQuery(params);

			const results = await tavilySearch(
				built.query,
				count,
				apiKey,
				built.site,
				signal,
			);

			return {
				content: [
					{
						type: "text" as const,
						text: formatResults(results),
					},
				],

				details: {
					composedQuery: built.displayQuery,
					query: built.baseQuery,
					exactPhrases: built.exactPhrases,
					excludeTerms: built.excludeTerms,
					site: built.site,
					resultCount: results.length,
					provider: "tavily",
				},
			};
		},

		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);

			const { count, ...searchArgs } =
				args as StructuredSearchArgs;

			try {
				const built = buildSearchQuery(searchArgs);

				const display =
					built.displayQuery.length > 70
						? built.displayQuery.slice(0, 67) + "..."
						: built.displayQuery;

				const lines = [
					theme.fg(
						"toolTitle",
						theme.bold("search "),
					) +
						theme.fg(
							"accent",
							`"${display}"`,
						),
				];

				if (count && count !== 5) {
					lines.push(
						theme.fg(
							"dim",
							`  count: ${count}`,
						),
					);
				}

				text.setText(lines.join("\n"));
				return text;
			} catch {
				text.setText(
					theme.fg(
						"toolTitle",
						theme.bold("search "),
					) +
						theme.fg(
							"error",
							"(invalid query)",
						),
				);

				return text;
			}
		},

		renderResult(
			result,
			{ expanded, isPartial },
			theme,
			context,
		) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);

			if (isPartial) {
				text.setText(
					theme.fg("warning", "Searching…"),
				);
				return text;
			}

			if (context.isError) {
				const msg =
					result.content.find(
						(c) => c.type === "text",
					)?.text || "Error";

				text.setText(
					theme.fg("error", msg),
				);

				return text;
			}

			const details = result.details as {
				composedQuery?: string;
				resultCount?: number;
				provider?: string;
			};

			const status = theme.fg(
				"success",
				`${details?.resultCount ?? 0} results`,
			);

			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content =
				result.content.find(
					(c) => c.type === "text",
				)?.text || "";

			const preview =
				content.length > 500
					? content.slice(0, 500) + "..."
					: content;

			const queryLine = details?.composedQuery
				? theme.fg(
						"dim",
						`query: ${details.composedQuery}`,
					)
				: "";

			const providerLine = theme.fg(
				"dim",
				"provider: Tavily",
			);

			text.setText(
				[
					status,
					queryLine,
					providerLine,
					theme.fg("dim", preview),
				]
					.filter(Boolean)
					.join("\n"),
			);

			return text;
		},
	});
}

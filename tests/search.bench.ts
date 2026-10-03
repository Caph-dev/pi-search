import { bench, beforeAll, describe, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("wreq-js", () => ({ fetch: vi.fn() }));
vi.mock("defuddle/node", () => ({ Defuddle: vi.fn() }));

import extension from "../index.ts";

type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
const tools = new Map<string, Tool>();
let activeTools: string[] = [];
extension({
	on() {},
	registerTool(tool: Tool) { tools.set(tool.name, tool); activeTools.push(tool.name); },
	registerCommand() {},
	registerMessageRenderer() {},
	getActiveTools() { return activeTools; },
	setActiveTools(names: string[]) { activeTools = names; },
} as unknown as ExtensionAPI);

const ctx = { ui: { setStatus() {} } };
function run(name: string, params: Record<string, unknown>) {
	return tools.get(name)!.execute("bench", params, undefined, undefined, ctx);
}
function json(value: unknown) {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
const answer = 'data: {"choices":[{"delta":{"content":"Benchmark answer"}}]}\n\ndata: [DONE]\n\n';
const options = { iterations: 10, time: 0, warmupIterations: 1, warmupTime: 0 };
let queryId = 0;

beforeAll(async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-search-bench-"));
	process.env.PI_SEARCH_CONFIG_PATH = join(root, "config.json");
	process.env.PI_SEARCH_CONTEXT7_CACHE_DIR = join(root, "cache");
	process.env.SEARCH_API_URL = "https://search.test/v1";
	process.env.SEARCH_API_KEY = "test";
	process.env.SEARCH_MODEL = "benchmark-model";
	process.env.CONTEXT7_BASE_URL = "https://context7.test";
	process.env.EXA_BASE_URL = "https://exa.test";
	process.env.SEARCH_FALLBACK_MODE = "auto";
	delete process.env.SEARCH_API_PROTOCOL;
	delete process.env.SEARCH_DEBUG;
	delete process.env.TAVILY_API_KEY;
	delete process.env.FIRECRAWL_API_KEY;
});

describe("search latency with controlled providers (no live API)", () => {
	bench("cold docs: resolve 40ms + docs 40ms + Exa 80ms", async () => {
		process.env.EXA_API_KEY = "test";
		globalThis.fetch = async (input) => {
			const url = String(input);
			await sleep(url.includes("exa.test") ? 80 : 40);
			if (url.includes("/api/v2/search")) return json({ results: [{ id: "/bench/docs", title: "Docs" }] });
			if (url.includes("/api/v2/context")) return json({ codeSnippets: [{ content: "Documentation" }] });
			return json({ results: [{ url: "https://example.com/docs" }] });
		};
		await run("docs_search", { query: `cold ${queryId++}`, provider: "all" });
	}, options);

	bench("warm Context7 docs: cached resolve and document", async () => {
		delete process.env.EXA_API_KEY;
		globalThis.fetch = async (input) => {
			await sleep(40);
			return String(input).includes("/api/v2/search")
				? json({ results: [{ id: "/bench/docs", title: "Docs" }] })
				: json({ codeSnippets: [{ content: "Documentation" }] });
		};
		await run("docs_search", { query: "warm docs", provider: "context7" });
	}, options);

	bench("cold model override: model list 80ms + search 20ms", async () => {
		delete process.env.EXA_API_KEY;
		process.env.SEARCH_API_URL = `https://search.test/override-${queryId++}/v1`;
		globalThis.fetch = async (input) => {
			if (String(input).endsWith("/models")) {
				await sleep(80);
				return json({ data: [{ id: "override-model" }] });
			}
			await sleep(20);
			return new Response(answer);
		};
		await run("search", { query: "override", model: "override-model", max_sources: 0 });
	}, options);

	bench("SSE terminal: answer 20ms, connection close 120ms", async () => {
		delete process.env.EXA_API_KEY;
		globalThis.fetch = async () => {
			await sleep(20);
			let timer: ReturnType<typeof setTimeout>;
			return new Response(new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(answer));
					timer = setTimeout(() => controller.close(), 120);
				},
				cancel() { clearTimeout(timer); },
			}));
		};
		await run("search", { query: "terminal", max_sources: 0 });
	}, options);

	bench("slow enrichment: primary 20ms, docs 120ms, budget 30ms", async () => {
		delete process.env.EXA_API_KEY;
		globalThis.fetch = async (input, init) => {
			if (String(input).includes("/chat/completions")) {
				await sleep(20);
				return new Response(answer);
			}
			await sleep(120, undefined, { signal: init?.signal ?? undefined });
			return json({ results: [{ id: "/bench/docs", title: "Docs" }] });
		};
		await run("search", { query: `React API slow ${queryId++}`, enrichment_timeout_ms: 30 });
	}, options);
});

import { describe, expect, test } from "bun:test";

import { type CatalogModel, resolvePiModel } from "./resolve-pi-model.ts";

function catalog(
	entries: Record<string, CatalogModel>,
): (provider: string, id: string) => CatalogModel | undefined {
	return (provider, id) => entries[`${provider}/${id}`];
}

const grok46: CatalogModel = {
	id: "grok-4.6",
	name: "Grok 4.6",
	contextWindow: 500_000,
	maxTokens: 500_000,
};

const orDeepseek: CatalogModel = {
	id: "deepseek/deepseek-chat",
	name: "DeepSeek",
	contextWindow: 64_000,
	maxTokens: 8_000,
};

describe("resolvePiModel", () => {
	test("returns a catalog hit unchanged", () => {
		const get = catalog({
			"xai/grok-4.7": { id: "grok-4.7", name: "Grok 4.7" },
		});
		expect(resolvePiModel("xai/grok-4.7", get)).toEqual({
			id: "grok-4.7",
			name: "Grok 4.7",
		});
	});

	test("clones grok-4.6 for an unknown xAI id, keeping sibling limits", () => {
		const get = catalog({ "xai/grok-4.6": grok46 });
		expect(resolvePiModel("xai/grok-4.7", get)).toEqual({
			...grok46,
			id: "grok-4.7",
			name: "grok-4.7",
		});
	});

	test("falls back through older grok templates", () => {
		const get = catalog({
			"xai/grok-4.5": { id: "grok-4.5", name: "Grok 4.5" },
		});
		expect(resolvePiModel("xai/grok-4.7", get).id).toBe("grok-4.7");
		expect(resolvePiModel("xai/grok-4.7", get).name).toBe("grok-4.7");
	});

	test("unknown OpenRouter ids clone the generic sibling with conservative limits", () => {
		const get = catalog({
			"openrouter/deepseek/deepseek-chat": orDeepseek,
		});
		expect(resolvePiModel("openrouter/acme/new-model", get)).toEqual({
			...orDeepseek,
			id: "acme/new-model",
			name: "acme/new-model",
			contextWindow: 128_000,
			maxTokens: 16_000,
		});
	});

	test("unknown Anthropic ids still throw when no Anthropic sibling exists", () => {
		const get = catalog({ "xai/grok-4.6": grok46 });
		expect(() => resolvePiModel("anthropic/claude-future", get)).toThrow(
			/Unknown model/,
		);
	});

	test("clones claude-opus-5 for an unlisted Anthropic id", () => {
		const opus5: CatalogModel = {
			id: "claude-opus-5",
			name: "Claude Opus 5",
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		};
		const get = catalog({ "anthropic/claude-opus-5": opus5 });
		expect(resolvePiModel("anthropic/claude-opus-5-5", get)).toEqual({
			...opus5,
			id: "claude-opus-5-5",
			name: "claude-opus-5-5",
		});
	});

	test("rejects a spec without a provider slash", () => {
		expect(() => resolvePiModel("grok-4.7", catalog({}))).toThrow(
			/provider\/model/,
		);
	});
});

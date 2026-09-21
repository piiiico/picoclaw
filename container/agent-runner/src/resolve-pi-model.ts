/**
 * Resolve `provider/model-id` against pi's catalog. Unknown ids on a
 * single-protocol provider are accepted by cloning a catalog sibling's wire
 * config so `/new grok` can track a newly-shipped flagship before pi's
 * bundled catalog lists it.
 */

export type CatalogLookup<T> = (provider: string, id: string) => T | undefined;

export type CatalogModel = {
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
};

const XAI_CLONE_TEMPLATES = ["grok-4.6", "grok-4.5", "grok-4.3"] as const;

export function resolvePiModel<T extends CatalogModel>(
	spec: string,
	getModel: CatalogLookup<T>,
	log: (msg: string) => void = () => {},
): T {
	const slash = spec.indexOf("/");
	if (slash < 1) {
		throw new Error(`PICOCLAW_MODEL must be provider/model, got "${spec}"`);
	}
	const provider = spec.slice(0, slash);
	const id = spec.slice(slash + 1);
	const known = getModel(provider, id);
	if (known) return known;
	if (provider === "openrouter") {
		const template = getModel("openrouter", "deepseek/deepseek-chat");
		if (template) {
			log(`Model ${spec} not in catalog; using generic OpenRouter config`);
			return {
				...template,
				id,
				name: id,
				contextWindow: 128_000,
				maxTokens: 16_000,
			};
		}
	}
	if (provider === "xai") {
		for (const templateId of XAI_CLONE_TEMPLATES) {
			const template = getModel("xai", templateId);
			if (!template) continue;
			log(`Model ${spec} not in catalog; cloning ${template.id} wire config`);
			return { ...template, id, name: id };
		}
	}
	throw new Error(`Unknown model "${spec}" for provider "${provider}"`);
}

import { describe, expect, test } from "bun:test";

import {
	DEFAULT_INTERACTIVE_MODEL,
	MODEL_ALIASES,
	pickGrokFlagship,
	resolveEffort,
	resolveGrokShorthand,
	resolveModelId,
	resolveModelTarget,
} from "./config.ts";
import { type IpcDeps, processTaskIpc } from "./ipc.ts";
import type { ScheduledTask } from "./types.ts";

/**
 * These tests pin the behavior behind the fix: a scheduled task stores the
 * model string verbatim (e.g. "opus") and the alias is resolved at spawn time
 * via resolveModelId — not frozen when the task was defined. A task running
 * daily for months must therefore track whatever "opus" currently points at.
 */

describe("resolveModelId (spawn-time resolution)", () => {
	test("resolves an alias to its current target", () => {
		// Assert the logical mapping, not a hardcoded version string, so bumping
		// the alias target in config does not break this test.
		expect(resolveModelId("opus")).toBe(MODEL_ALIASES["opus"] as string);
		expect(resolveModelId("opus")).not.toBe("opus");
	});

	test("opus targets claude-opus-5-5; opus-5 stays on claude-opus-5", () => {
		expect(resolveModelId("opus")).toBe("claude-opus-5-5");
		expect(resolveModelId("opus-5.5")).toBe("claude-opus-5-5");
		expect(resolveModelId("opus-5")).toBe("claude-opus-5");
	});

	test("interactive default follows the opus alias", () => {
		expect(DEFAULT_INTERACTIVE_MODEL).toBe("opus");
		expect(resolveModelId(DEFAULT_INTERACTIVE_MODEL)).toBe("claude-opus-5-5");
	});

	test("is case-insensitive", () => {
		expect(resolveModelId("OPUS")).toBe(MODEL_ALIASES["opus"] as string);
	});

	test("passes concrete model ids through unchanged (existing tasks)", () => {
		// Existing tasks already store a resolved id; resolving again must be a
		// no-op so they keep working.
		expect(resolveModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
	});

	test("is idempotent — resolving twice equals resolving once", () => {
		const once = resolveModelId("opus");
		expect(resolveModelId(once)).toBe(once);
	});

	test("passes unknown strings through (original syntax keeps working)", () => {
		expect(resolveModelId("claude-some-future-model")).toBe(
			"claude-some-future-model",
		);
	});

	test("resolves a provider-backed alias to its model id", () => {
		// resolveModelId stays string-in/string-out for all callers.
		expect(resolveModelId("k3")).toBe("kimi-k3");
		expect(resolveModelId("kimi")).toBe("moonshotai/kimi-k3");
	});
});

describe("resolveModelTarget (provider-aware resolution)", () => {
	test("plain aliases resolve without a provider (Anthropic default)", () => {
		const target = resolveModelTarget("opus");
		expect(target.model).toBe(resolveModelId("opus"));
		expect(target.provider).toBeUndefined();
	});

	test("unknown strings pass through without a provider", () => {
		const target = resolveModelTarget("claude-some-future-model");
		expect(target.model).toBe("claude-some-future-model");
		expect(target.provider).toBeUndefined();
	});

	test("k3 routes direct to Moonshot", () => {
		const target = resolveModelTarget("k3");
		expect(target.model).toBe("kimi-k3");
		expect(target.provider?.id).toBe("moonshotai");
		expect(target.provider?.apiKeyEnvVar).toBe("MOONSHOT_API_KEY");
	});

	test("any vendor/model id routes via OpenRouter — no per-model hardcoding", () => {
		for (const id of [
			"moonshotai/kimi-k3",
			"deepseek/deepseek-chat",
			"openai/o3",
		]) {
			const target = resolveModelTarget(id);
			expect(target.model).toBe(id);
			expect(target.provider?.id).toBe("openrouter");
			expect(target.provider?.apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
		}
	});

	test("string aliases pointing at a vendor/model id inherit the OpenRouter provider", () => {
		const target = resolveModelTarget("kimi");
		expect(target.model).toBe("moonshotai/kimi-k3");
		expect(target.provider?.id).toBe("openrouter");
	});

	test("Anthropic ids and aliases never get a provider (subscription auth untouched)", () => {
		expect(resolveModelTarget("fable").provider).toBeUndefined();
		expect(resolveModelTarget("claude-opus-4-8").provider).toBeUndefined();
	});

	test("is case-insensitive like resolveModelId", () => {
		expect(resolveModelTarget("K3").model).toBe("kimi-k3");
	});

	test("unlisted grok-* ids route to xAI, not Anthropic", () => {
		const target = resolveModelTarget("grok-4.8");
		expect(target.provider?.id).toBe("xai");
		expect(target.model).toBe("grok-4.8");
	});
});

function makeDeps(): { deps: IpcDeps; tasks: () => ScheduledTask[] } {
	let store: ScheduledTask[] = [];
	return {
		deps: {
			getAllowedChatId: () => "chat-1",
			readTasks: () => store,
			writeTasks: (t) => {
				store = t;
			},
			writeSnapshot: () => {},
			sendMessage: async () => {},
		},
		tasks: () => store,
	};
}

function schedule(deps: IpcDeps, model: string | undefined): void {
	processTaskIpc(
		{
			type: "schedule",
			prompt: "daily report",
			schedule_type: "cron",
			schedule_value: "0 9 * * *",
			...(model !== undefined ? { model } : {}),
		},
		"chat-1",
		deps,
	);
}

describe("processTaskIpc (definition-time storage)", () => {
	test("stores an alias verbatim — does NOT freeze it to a version", () => {
		const { deps, tasks } = makeDeps();
		schedule(deps, "opus");
		const [task] = tasks();
		expect(task?.model).toBe("opus");
	});

	test("stored alias resolves to the current target at spawn time", () => {
		const { deps, tasks } = makeDeps();
		schedule(deps, "opus");
		const [task] = tasks();
		// Simulates what spawnContainer does just before launching the container.
		expect(resolveModelId(task?.model as string)).toBe(
			MODEL_ALIASES["opus"] as string,
		);
	});

	test("stores a concrete model id verbatim (original syntax still works)", () => {
		const { deps, tasks } = makeDeps();
		schedule(deps, "claude-opus-4-8");
		const [task] = tasks();
		expect(task?.model).toBe("claude-opus-4-8");
	});

	test("leaves model undefined when none is provided", () => {
		const { deps, tasks } = makeDeps();
		schedule(deps, undefined);
		const [task] = tasks();
		expect(task?.model).toBeUndefined();
	});

	test("upsert by label updates the alias without resolving it", () => {
		const { deps, tasks } = makeDeps();
		processTaskIpc(
			{
				type: "schedule",
				label: "report",
				prompt: "daily report",
				schedule_type: "cron",
				schedule_value: "0 9 * * *",
				model: "claude-opus-4-7",
			},
			"chat-1",
			deps,
		);
		processTaskIpc(
			{
				type: "schedule",
				label: "report",
				prompt: "daily report",
				schedule_type: "cron",
				schedule_value: "0 9 * * *",
				model: "opus",
			},
			"chat-1",
			deps,
		);
		expect(tasks()).toHaveLength(1);
		expect(tasks()[0]?.model).toBe("opus");
	});
});

describe("resolveEffort", () => {
	test("grok without an explicit level is xhigh", () => {
		expect(resolveEffort({ model: "grok" })).toBe("xhigh");
		expect(resolveEffort({ model: "grok-4.7" })).toBe("xhigh");
	});

	test("an explicit level wins over the grok default", () => {
		expect(resolveEffort({ model: "grok", explicit: "high" })).toBe("high");
	});

	test("bot defaultEffort does not demote grok off xhigh", () => {
		expect(resolveEffort({ model: "grok", botDefault: "high" })).toBe("xhigh");
	});

	test("opus 5.5 without an explicit level is medium", () => {
		expect(resolveEffort({ model: "opus" })).toBe("medium");
		expect(resolveEffort({ model: "claude-opus-5-5" })).toBe("medium");
	});

	test("an explicit level wins over the opus 5.5 default", () => {
		expect(resolveEffort({ model: "opus", explicit: "high" })).toBe("high");
	});

	test("bot defaultEffort does not demote opus 5.5 off medium", () => {
		expect(resolveEffort({ model: "opus", botDefault: "high" })).toBe("medium");
	});

	test("older opus pins and other models keep the bot default", () => {
		expect(resolveEffort({ model: "opus-5", botDefault: "high" })).toBe("high");
		expect(resolveEffort({ model: "sonnet", botDefault: "high" })).toBe("high");
		expect(resolveEffort({ model: "opus-5" })).toBeUndefined();
	});
});

describe("pickGrokFlagship", () => {
	const catalog = [
		"grok-4.20",
		"grok-4.20-0309-reasoning",
		"grok-4.3",
		"grok-4.5",
		"grok-4.6",
		"grok-4.7",
		"grok-build-0.1",
	];

	test("picks grok-4.7 over grok-4.20", () => {
		expect(pickGrokFlagship(catalog)).toBe("grok-4.7");
	});

	test("follows a newer single-digit minor without a pin bump", () => {
		expect(pickGrokFlagship([...catalog, "grok-4.8"])).toBe("grok-4.8");
	});

	test("empty catalog returns null so the pin remains", () => {
		expect(pickGrokFlagship([])).toBeNull();
	});
});

describe("resolveGrokShorthand", () => {
	test("the word grok overlays onto the live flagship", () => {
		const t = resolveGrokShorthand("grok", [
			"grok-4.6",
			"grok-4.8",
			"grok-4.20",
		]);
		expect(t.model).toBe("grok-4.8");
		expect(t.provider?.id).toBe("xai");
	});

	test("an explicit grok-4.6 is not rewritten", () => {
		expect(resolveGrokShorthand("grok-4.6", ["grok-4.8"]).model).toBe(
			"grok-4.6",
		);
	});

	test("falls back to the pin when the live list is empty", () => {
		expect(resolveGrokShorthand("grok", []).model).toBe("grok-4.7");
	});
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BotConfig, EffortLevel } from "./types.ts";
import { resolveXaiAccessToken } from "./xai-oauth.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const WORKSPACES_DIR = "/mnt/HC_Volume_105140258/picoclaw/workspaces";
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const CONTAINER_DIR = path.join(PROJECT_ROOT, "container");
export const SEEDS_DIR = path.join(CONTAINER_DIR, "seeds");
/** Host-owned executables a scheduled task may name as its `precondition`. */
export const PRECONDITIONS_DIR = path.join(PROJECT_ROOT, "preconditions");

export const CONTAINER_BASE_IMAGE = "picoclaw-base:latest";
export const CONTAINER_TIMEOUT = 60 * 60 * 1000; // 60 min hard timeout
export const IDLE_TIMEOUT = 60 * 60 * 1000; // 60 min idle → close
export const IPC_POLL_INTERVAL = 1000; // 1s
export const TASK_CHECK_INTERVAL = 60 * 1000; // 60s
// A precondition runs on the host, in front of a container that costs ~30K
// tokens to boot. It must be cheap; this bound is a backstop, not a budget.
export const PRECONDITION_TIMEOUT = 30 * 1000; // 30s
export const TELEGRAM_POLL_TIMEOUT = 30; // seconds

/**
 * A pi provider the runner can route to. The runner resolves
 * `provider/model-id` against pi's model catalog and hands it the credential
 * directly, so every backend shares one harness (system prompt, CLAUDE.md,
 * skills, IPC). Provider ids are pi's: https://github.com/earendil-works/pi
 */
export interface ProviderConfig {
	/** pi provider id (`anthropic`, `openrouter`, `moonshotai`, `xai`). */
	id: string;
	/** Host env var holding the provider API key (never stored in bots.json). */
	apiKeyEnvVar: string;
	/**
	 * Credential source for providers whose key is not a static env var — e.g. a
	 * short-lived OAuth token a vendor CLI maintains on disk. When present it
	 * wins over `apiKeyEnvVar`; null means "not configured on this host", which
	 * raises the same missing-key error as an unset env var.
	 */
	resolveKey?: (() => string | null) | undefined;
}

export interface ModelTarget {
	model: string;
	/** Omitted → Anthropic, authenticated with the bot's own key/OAuth token. */
	provider?: ProviderConfig | undefined;
}

/** Any `vendor/model` id routes through OpenRouter generically. */
export const OPENROUTER_PROVIDER: ProviderConfig = {
	id: "openrouter",
	apiKeyEnvVar: "OPENROUTER_API_KEY",
};

export const MOONSHOT_PROVIDER: ProviderConfig = {
	id: "moonshotai",
	apiKeyEnvVar: "MOONSHOT_API_KEY",
};

/**
 * xAI via SuperGrok OAuth (`grok login` on the host). Inert until an
 * operator has logged in. PicoClaw only reads ~/.grok/auth.json.
 */
export const XAI_PROVIDER: ProviderConfig = {
	id: "xai",
	apiKeyEnvVar: "XAI_API_KEY",
	// The token is minted once, at spawn, and never re-read — so it has to
	// outlive the longest a container can run. CONTAINER_TIMEOUT is that bound.
	resolveKey: () => resolveXaiAccessToken(CONTAINER_TIMEOUT),
};

/** Used when neither the session, the bot, nor ANTHROPIC_MODEL names a model. */
export const DEFAULT_MODEL = "claude-opus-5";

/**
 * Interactive sessions (Telegram/Slack) default to Grok when neither the
 * session, the bot config, nor ANTHROPIC_MODEL picks a model. Scheduled
 * (cron) containers keep DEFAULT_MODEL.
 */
export const DEFAULT_INTERACTIVE_MODEL = "grok";

export const MODEL_ALIASES: Record<string, string | ModelTarget> = {
	fable: "claude-fable-5",
	opus: "claude-opus-5",
	"opus-5": "claude-opus-5",
	"opus-4.8": "claude-opus-4-8",
	"opus-4.7": "claude-opus-4-7",
	"opus-4.6": "claude-opus-4-6",
	sonnet: "claude-sonnet-4-6",
	haiku: "claude-haiku-4-5-20251001",
	// Kimi K3 direct from Moonshot
	k3: { model: "kimi-k3", provider: MOONSHOT_PROVIDER },
	// Convenience shorthand; the slash form routes via OpenRouter (see below)
	kimi: "moonshotai/kimi-k3",
	// Grok on the host's own xAI login. Bare `grok-*` ids also route via
	// inferProvider (no per-version row). `x-ai/grok-4.7` still OpenRouter.
	// The WORD `grok` is a fallback pin. Spawn overlays it with the live
	// flagship from api.x.ai/v1/models (see pickGrokFlagship).
	grok: { model: "grok-4.7", provider: XAI_PROVIDER },
	"grok-4.7": { model: "grok-4.7", provider: XAI_PROVIDER },
	"grok-4.6": { model: "grok-4.6", provider: XAI_PROVIDER },
	"grok-4.5": { model: "grok-4.5", provider: XAI_PROVIDER },
};

/**
 * OpenRouter model ids are always "vendor/model"; Anthropic ids never contain
 * a slash. Any slash-form id therefore routes via OpenRouter generically —
 * `/new deepseek/deepseek-chat` works without touching this file.
 */
function inferProvider(model: string): ModelTarget {
	const lower = model.toLowerCase();
	// Slashless grok ids are xAI, not Anthropic. Without this, every new
	// `grok-4.x` needed a MODEL_ALIASES row and a host restart.
	if (lower.startsWith("grok-")) {
		return { model: lower, provider: XAI_PROVIDER };
	}
	return model.includes("/")
		? { model, provider: OPENROUTER_PROVIDER }
		: { model };
}

/** Token the Telegram/Slack parsers may treat as a model, not prompt text. */
export function isRoutableModelToken(tok: string): boolean {
	const t = tok.toLowerCase();
	return (
		MODEL_ALIASES[t] !== undefined || t.includes("/") || t.startsWith("grok-")
	);
}

export function resolveModelTarget(alias: string): ModelTarget {
	const entry = MODEL_ALIASES[alias.toLowerCase()];
	if (entry === undefined) return inferProvider(alias);
	return typeof entry === "string" ? inferProvider(entry) : entry;
}

export function resolveModelId(alias: string): string {
	return resolveModelTarget(alias).model;
}

/**
 * Coding-flagship line: `grok-4.7`, `grok-5.0`. Not `grok-4.20` (dated SKU
 * family; max() on the catalog would pick it over 4.7) and not grok-build.
 * Single digit after the last dot is the discriminator.
 */
const GROK_FLAGSHIP = /^grok-(\d+)\.(\d)$/;

export function pickGrokFlagship(ids: readonly string[]): string | null {
	let best: { id: string; major: number; minor: number } | null = null;
	for (const id of ids) {
		const m = GROK_FLAGSHIP.exec(id);
		if (!m) continue;
		const major = Number(m[1]);
		const minor = Number(m[2]);
		if (
			!best ||
			major > best.major ||
			(major === best.major && minor > best.minor)
		) {
			best = { id, major, minor };
		}
	}
	return best?.id ?? null;
}

/** The word `grok` follows the live flagship; `grok-4.6` stays pinned. */
export function resolveGrokShorthand(
	alias: string,
	liveIds: readonly string[] | undefined,
): ModelTarget {
	const target = resolveModelTarget(alias);
	if (alias.toLowerCase() !== "grok") return target;
	const live = liveIds ? pickGrokFlagship(liveIds) : null;
	return live ? { model: live, provider: XAI_PROVIDER } : target;
}

function isGrokId(alias: string): boolean {
	const id = resolveModelId(alias).toLowerCase();
	return id === "grok" || id.startsWith("grok-");
}

/**
 * Grok effort is xhigh unless the caller named a level. Bot defaultEffort
 * must not demote that — it is the Claude-session fallback, not a grok cap.
 * An explicit low/medium/high/max on the session, task, or `/new` still wins.
 */
export function resolveEffort(opts: {
	model?: string | undefined;
	explicit?: EffortLevel | undefined;
	botDefault?: EffortLevel | undefined;
}): EffortLevel | undefined {
	if (opts.explicit) return opts.explicit;
	if (opts.model && isGrokId(opts.model)) return "xhigh";
	return opts.botDefault;
}

const VALID_EFFORT_LEVELS = new Set<EffortLevel>([
	"low",
	"medium",
	"high",
	"max",
	"xhigh",
]);

export function parseEffortLevel(value: string): EffortLevel | null {
	const lower = value.toLowerCase() as EffortLevel;
	return VALID_EFFORT_LEVELS.has(lower) ? lower : null;
}

export function loadBotConfigs(): BotConfig[] {
	const botsFile = path.join(PROJECT_ROOT, "bots.json");
	if (!fs.existsSync(botsFile)) {
		throw new Error(`bots.json not found at ${botsFile}`);
	}
	const raw = JSON.parse(fs.readFileSync(botsFile, "utf-8"));
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error("bots.json must be a non-empty array");
	}
	// Migration: accept anthropicModel as fallback for defaultModel
	for (const entry of raw) {
		if (!entry.defaultModel && entry.anthropicModel) {
			entry.defaultModel = entry.anthropicModel;
			delete entry.anthropicModel;
		}
		if (!entry.anthropicApiKey) {
			throw new Error(
				`Bot "${entry.name}" is missing required "anthropicApiKey" in bots.json`,
			);
		}
	}
	return raw as BotConfig[];
}

export const OUTPUT_START_MARKER = "---PICOCLAW_OUTPUT_START---";
export const OUTPUT_END_MARKER = "---PICOCLAW_OUTPUT_END---";

export const SYSTEM_PROMPT = `You are an autonomous agent operating in a persistent Debian container with bash and curl.
/workspace persists between sessions. /workspace/CLAUDE.md is loaded into your context every session — keep it concise.
If /workspace/Dockerfile.extra exists, it extends your container image (cached, rebuilt only on change).
If /workspace/start.sh exists, it runs before you start.
To send a message while still working, write a JSON file to /ipc/messages/.`;

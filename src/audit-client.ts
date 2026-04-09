// AgentLair audit client — write-only access from PicoClaw host.
// Uses @piiiico/agent-logger (https://agentlair.dev/docs/audit-logger).
// The agent container never receives this API key, so it cannot read the audit trail.
//
// Supports per-bot API keys: each bot in bots.json can have its own agentlairApiKey,
// so different operators get separate audit trails. Falls back to the global
// AGENTLAIR_API_KEY env var / secrets file when a bot has no key configured.
import fs from "node:fs";
import { createAuditLogger } from "@piiiico/agent-logger";
import pino from "pino";

const log = pino({ name: "audit-client" });

type AuditLoggerFn = ReturnType<typeof createAuditLogger>;

function loadGlobalApiKey(): string {
	const fromEnv = process.env["AGENTLAIR_API_KEY"];
	if (fromEnv) return fromEnv;
	try {
		const raw = fs.readFileSync("/workspace/.secrets/agentlair.env", "utf-8");
		for (const line of raw.split("\n")) {
			const match = line.match(/^AGENTLAIR_API_KEY=(.+)$/);
			if (match?.[1]) return match[1].trim();
		}
	} catch {
		/* ignore */
	}
	return "";
}

const globalApiKey = loadGlobalApiKey();

if (globalApiKey) {
	log.info("Audit client initialized (AgentLair, global key)");
} else {
	log.warn("Audit client: no global AGENTLAIR_API_KEY found");
}

// Cache loggers by API key to avoid creating duplicates
const loggerCache = new Map<string, AuditLoggerFn>();

function getLogger(apiKey: string): AuditLoggerFn {
	const cached = loggerCache.get(apiKey);
	if (cached) return cached;
	const logger = createAuditLogger("picoclaw", {
		transport: apiKey ? "agentlair" : "silent",
		agentlairApiKey: apiKey,
	});
	loggerCache.set(apiKey, logger);
	return logger;
}

/** Resolve the effective API key: per-bot key takes priority over global. */
function resolveApiKey(botApiKey?: string | undefined): string {
	return botApiKey || globalApiKey;
}

export const audit = {
	/** Call once per bot at startup to log which bots have per-bot keys. */
	registerBot(botName: string, botApiKey?: string | undefined): void {
		const key = resolveApiKey(botApiKey);
		if (key && botApiKey) {
			log.info({ bot: botName }, "Audit: per-bot AgentLair key configured");
		} else if (key) {
			log.info({ bot: botName }, "Audit: using global AgentLair key");
		} else {
			log.warn({ bot: botName }, "Audit: no AgentLair key, logging disabled");
		}
	},

	sessionStart(opts: {
		sessionId: string;
		chatId: string;
		model?: string | undefined;
		sessionType?: string | undefined;
		source?: string | undefined;
		botApiKey?: string | undefined;
	}): void {
		const logger = getLogger(resolveApiKey(opts.botApiKey));
		logger({
			action: "session.start",
			metadata: {
				session_id: opts.sessionId,
				chat_id: opts.chatId,
				model: opts.model ?? null,
				session_type: opts.sessionType ?? null,
				source: opts.source ?? null,
			},
		}).catch((err: unknown) => {
			log.debug({ err }, "Audit fire-and-forget failed (ignored)");
		});
	},

	sessionEnd(opts: {
		sessionId: string;
		endReason?: string | undefined;
		botApiKey?: string | undefined;
	}): void {
		const logger = getLogger(resolveApiKey(opts.botApiKey));
		logger({
			action: "session.end",
			metadata: {
				session_id: opts.sessionId,
				end_reason: opts.endReason ?? null,
			},
		}).catch((err: unknown) => {
			log.debug({ err }, "Audit fire-and-forget failed (ignored)");
		});
	},

	event(opts: {
		sessionId: string;
		eventType: string;
		description?: string | undefined;
		metadata?: Record<string, unknown> | undefined;
		botApiKey?: string | undefined;
	}): void {
		const logger = getLogger(resolveApiKey(opts.botApiKey));
		const toolName =
			opts.eventType === "tool.use"
				? (opts.metadata?.["tool"] as string | undefined)
				: undefined;
		logger({
			action: opts.eventType,
			...(toolName ? { tool: toolName } : {}),
			metadata: {
				session_id: opts.sessionId,
				description: opts.description ?? null,
				...opts.metadata,
			},
		}).catch((err: unknown) => {
			log.debug({ err }, "Audit fire-and-forget failed (ignored)");
		});
	},
};

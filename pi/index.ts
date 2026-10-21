/**
 * agent-inbox for pi: the same persistent "waiting on you" list as the
 * Claude Code mod, against the same per-project JSON file, so an item one
 * agent flags shows up in the other.
 *
 * - Tools: flag_for_user, resolve_user_item (same names and contract as Claude Code)
 * - Widget above the editor while anything is open, plus a footer status
 * - /inbox (pick an item to close), /inbox add|done|drop|reopen N, /done N
 * - Open items are sent to the model (hidden) only when the list changed
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	FLAG_TOOL_DESCRIPTION,
	FLAG_TOOL_NAME,
	KIND_LABEL,
	KINDS,
	RESOLVE_TOOL_DESCRIPTION,
	RESOLVE_TOOL_NAME,
	addItem,
	closeItem,
	findProjectRoot,
	flagResultText,
	inboxDir,
	inboxPath,
	itemLine,
	modelSummary,
	openDigest,
	openItems,
	parseInbox,
	parseNumbers,
	reopenItem,
	resolveResultText,
	serializeInbox,
	type AddResult,
	type CloseResult,
	type Inbox,
	type Item,
} from "../core/inbox";

const SOURCE = "pi";
const WIDGET = "agent-inbox";
const POLL_MS = 3000;
const BAND_ROWS = 3;

const FlagParams = Type.Object({
	title: Type.String({ description: "Imperative, short: what the human must do." }),
	detail: Type.Optional(
		Type.String({ description: "Optional: exact commands, file paths, links, or why it is needed." }),
	),
	kind: Type.Optional(
		StringEnum(KINDS as unknown as ["action", "decision", "review", "secret", "info"], {
			description:
				"action = do something; decision = choose; review = look at something; secret = provide a credential/value; info = needs to know. Default action.",
		}),
	),
	blocking: Type.Optional(
		Type.Boolean({ description: "True if your current work is stuck until this is handled." }),
	),
});

const ResolveParams = Type.Object({
	n: Type.Integer({ description: "The item number, as in #3." }),
	status: Type.Optional(StringEnum(["done", "dropped"] as const, { description: "Default done." })),
	note: Type.Optional(Type.String({ description: "Optional: how it was resolved." })),
});

export default function agentInbox(pi: ExtensionAPI) {
	let path: string | undefined;
	let project = "";
	let inbox: Inbox | undefined;
	let lastMtime = -1;
	let lastToldDigest: string | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	let uiCtx: ExtensionContext | undefined;

	// ------------------------------------------------------------ file I/O

	const resolvePath = async (cwd: string): Promise<string> => {
		if (path) return path;
		project = await findProjectRoot(cwd, async (p) => existsSync(p));
		path = inboxPath(inboxDir(homedir(), process.env.AGENT_INBOX_DIR), project);
		return path;
	};

	const readInbox = (): Inbox => {
		if (!path || !existsSync(path)) {
			lastMtime = 0;
			return parseInbox("", project);
		}
		lastMtime = statSync(path).mtimeMs;
		return parseInbox(readFileSync(path, "utf8"), project);
	};

	const writeInbox = (next: Inbox) => {
		if (!path) return;
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, serializeInbox(next));
		renameSync(tmp, path); // atomic: the Claude Code side never reads half a file
		lastMtime = statSync(path).mtimeMs;
	};

	/** Re-read the file, apply `change`, write it if it changed, redraw. */
	const mutate = <R extends { inbox: Inbox; ok: boolean }>(change: (current: Inbox, now: string) => R): R => {
		const current = readInbox();
		const result = change(current, new Date().toISOString());
		if (result.ok && result.inbox !== current) writeInbox(result.inbox);
		inbox = result.inbox;
		render();
		return result;
	};

	const reload = () => {
		inbox = readInbox();
		render();
	};

	const flag = (input: { title: string; detail?: string; kind?: string; blocking?: boolean }, source: string) =>
		mutate((current, now): AddResult => addItem(current, input, { now, source, id: randomUUID() }));

	const close = (n: number, status: "done" | "dropped", by: string, note?: string) =>
		mutate((current, now): CloseResult => closeItem(current, n, status, { now, by, note }));

	// ------------------------------------------------------------ drawing

	const render = () => {
		const ctx = uiCtx;
		if (!ctx?.hasUI) return;
		const open = inbox ? openItems(inbox) : [];
		if (open.length === 0) {
			ctx.ui.setWidget(WIDGET, undefined);
			ctx.ui.setStatus(WIDGET, undefined);
			return;
		}
		const blocking = open.filter((i) => i.blocking).length;
		ctx.ui.setStatus(WIDGET, `⚑ ${open.length}${blocking ? ` (${blocking}!)` : ""}`);
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET, (_tui, theme) => ({
			render(width: number): string[] {
				const clip = (s: string) => (s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s);
				const head =
					theme.fg("warning", `⚑ ${open.length} waiting on you`) +
					(blocking ? theme.fg("error", ` · ${blocking} blocking`) : "") +
					theme.fg("dim", " · /done N · /inbox");
				const rows = open.slice(0, BAND_ROWS).map((i: Item) => {
					const line = clip(`  #${i.n} ${i.title}`);
					return i.blocking ? theme.fg("error", line) : theme.fg("text", line);
				});
				if (open.length > BAND_ROWS) rows.push(theme.fg("dim", `  +${open.length - BAND_ROWS} more`));
				return [head, ...rows];
			},
			invalidate() {},
		}));
	};

	// ------------------------------------------------------------ session

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		path = undefined;
		lastToldDigest = undefined;
		await resolvePath(ctx.cwd);
		reload();
		if (poll) clearInterval(poll);
		// Another agent (Claude Code, a second pi) may change the file.
		poll = setInterval(() => {
			try {
				const mtime = path && existsSync(path) ? statSync(path).mtimeMs : 0;
				if (mtime !== lastMtime) reload();
			} catch {
				/* the next tick tries again */
			}
		}, POLL_MS);
		poll.unref?.();
	});

	pi.on("session_shutdown", async () => {
		if (poll) clearInterval(poll);
		poll = undefined;
	});

	// Tell the model what is open, only when that changed since it last heard.
	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user") return;
		reload();
		if (!inbox) return;
		const digest = openDigest(inbox);
		const isFirst = lastToldDigest === undefined;
		if (digest === lastToldDigest || (isFirst && digest === "")) return;
		lastToldDigest = digest;
		return { message: { customType: "agent-inbox", content: modelSummary(inbox), display: false } };
	});

	// ------------------------------------------------------------ tools

	pi.registerTool({
		name: FLAG_TOOL_NAME,
		label: "Flag for user",
		description: FLAG_TOOL_DESCRIPTION,
		promptSnippet: "Put something only the human can do into their persistent inbox",
		promptGuidelines: [
			"When you hand work back to the human (a secret to set, a decision, a review, a step on their machine), call flag_for_user once per item instead of only listing it in your reply.",
		],
		parameters: FlagParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await resolvePath(ctx.cwd);
			const r = flag(params, SOURCE);
			if (r.ok && !r.isDuplicate) {
				lastToldDigest = openDigest(r.inbox);
				if (ctx.hasUI) ctx.ui.notify(`Waiting on you: #${r.item.n} ${r.item.title}`, "info");
			}
			return {
				content: [{ type: "text", text: flagResultText(r, openItems(r.inbox).length) }],
				details: r.ok ? { n: r.item.n, isDuplicate: r.isDuplicate } : { error: r.error },
			};
		},
	});

	pi.registerTool({
		name: RESOLVE_TOOL_NAME,
		label: "Resolve user item",
		description: RESOLVE_TOOL_DESCRIPTION,
		parameters: ResolveParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await resolvePath(ctx.cwd);
			const r = close(params.n, params.status === "dropped" ? "dropped" : "done", SOURCE, params.note);
			if (r.ok) lastToldDigest = openDigest(r.inbox);
			return {
				content: [{ type: "text", text: resolveResultText(r) }],
				details: r.ok ? { n: r.item.n, status: r.item.status } : { error: r.error },
			};
		},
	});

	// ------------------------------------------------------------ commands

	const runVerb = (verb: string, rest: string): string => {
		if (verb === "add") {
			const r = flag({ title: rest }, "you");
			return r.ok ? `Added #${r.item.n}.` : `Not added: ${r.error}.`;
		}
		const ns = parseNumbers(rest);
		if (ns.length === 0) return verb === "done" ? "Usage: /done N [N…]" : `Usage: /inbox ${verb} N [N…]`;
		return ns
			.map((n) => {
				if (verb === "reopen") {
					const r = mutate((current) => reopenItem(current, n));
					return r.ok ? `#${n} reopened.` : resolveResultText(r);
				}
				return resolveResultText(close(n, verb === "drop" ? "dropped" : "done", "you"));
			})
			.join("\n");
	};

	const tell = (ctx: ExtensionContext, text: string) => {
		if (ctx.hasUI) ctx.ui.notify(text, text.startsWith("Not") || text.startsWith("Usage") ? "warning" : "info");
		else console.log(text);
	};

	/** No arguments: pick an open item, then what to do with it. */
	const browse = async (ctx: ExtensionContext) => {
		reload();
		const open = inbox ? openItems(inbox) : [];
		if (open.length === 0) return tell(ctx, "Nothing waiting on you.");
		if (!ctx.hasUI) return tell(ctx, open.map(itemLine).join("\n"));
		const labels = open.map((i) => `#${i.n} ${i.blocking ? "⚠ " : ""}[${KIND_LABEL[i.kind]}] ${i.title}`);
		const picked = await ctx.ui.select(`${open.length} waiting on you`, labels);
		const item = open[labels.indexOf(picked ?? "")];
		if (!item) return;
		const info = [item.detail, `from ${item.source} · ${item.createdAt.slice(0, 16).replace("T", " ")}`]
			.filter(Boolean)
			.join("\n");
		const action = await ctx.ui.select(`#${item.n} ${item.title}\n${info}`, ["Done", "Drop", "Back"]);
		if (action === "Done") tell(ctx, resolveResultText(close(item.n, "done", "you")));
		else if (action === "Drop") tell(ctx, resolveResultText(close(item.n, "dropped", "you")));
	};

	const completions = (prefix: string) => {
		const open = inbox ? openItems(inbox) : [];
		return open
			.map((i) => ({ value: String(i.n), label: `#${i.n} ${i.title}` }))
			.filter((c) => c.value.startsWith(prefix.trim().split(/\s+/).pop() ?? ""));
	};

	pi.registerCommand("inbox", {
		description: "What agents are waiting on you for (pick one, or add/done/drop/reopen N)",
		handler: async (args, ctx) => {
			await resolvePath(ctx.cwd);
			const trimmed = args.trim();
			if (!trimmed) return browse(ctx);
			const [verb = "", ...rest] = trimmed.split(/\s+/);
			if (["add", "done", "drop", "reopen"].includes(verb)) return tell(ctx, runVerb(verb, rest.join(" ")));
			if (/^#?\d/.test(verb)) return tell(ctx, runVerb("done", trimmed));
			tell(ctx, "Usage: /inbox [add <text> | done N | drop N | reopen N]");
		},
	});

	pi.registerCommand("done", {
		description: "Mark inbox items done: /done 3 or /done 3 4",
		getArgumentCompletions: completions,
		handler: async (args, ctx) => {
			await resolvePath(ctx.cwd);
			tell(ctx, runVerb("done", args));
		},
	});
}

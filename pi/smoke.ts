/**
 * End-to-end smoke test of the pi extension, against a scripted model (pi's
 * faux provider) in a throwaway project and inbox folder. No API key needed.
 *
 *   npm install && npm run test:pi
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	ModelRuntime,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const extensionPath = resolve(process.argv[2] ?? new URL("./index.ts", import.meta.url).pathname);

const work = mkdtempSync(join(tmpdir(), "agent-inbox-pi-"));
const project = join(work, "healthforge");
const inboxes = join(work, "inboxes");
mkdirSync(join(project, ".git"), { recursive: true });
mkdirSync(join(project, "src"), { recursive: true });
process.env.AGENT_INBOX_DIR = inboxes;

const readInbox = () => {
	const files = readdirSync(inboxes).filter((f) => f.endsWith(".json"));
	assert.equal(files.length, 1, "one inbox file for the project");
	return { file: join(inboxes, files[0]!), json: JSON.parse(readFileSync(join(inboxes, files[0]!), "utf8")) };
};

const faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
const seen: string[] = [];
faux.setResponses([
	fauxAssistantMessage(
		fauxToolCall("flag_for_user", {
			title: "Add STRIPE_SECRET_KEY to .env.local",
			kind: "secret",
			blocking: true,
			detail: "Get it from the Stripe dashboard → Developers → API keys",
		}),
		{ stopReason: "toolUse" },
	),
	fauxAssistantMessage("I need the Stripe key; it's #1 in your inbox."),
	(context) => {
		seen.push(JSON.stringify(context.messages));
		return fauxAssistantMessage(fauxToolCall("resolve_user_item", { n: 1, note: "key is set" }), {
			stopReason: "toolUse",
		});
	},
	fauxAssistantMessage([fauxText("Closed #1.")]),
]);

const modelRuntime = await ModelRuntime.create({
	authPath: join(work, "auth.json"),
	modelsPath: join(work, "models.json"),
});
await modelRuntime.setRuntimeApiKey(faux.getModel().provider, "faux-key");

const resourceLoader = new DefaultResourceLoader({
	cwd: join(project, "src"),
	agentDir: work,
	additionalExtensionPaths: [extensionPath],
	extensionFactories: [
		(pi: ExtensionAPI) => {
			const m = faux.getModel();
			pi.registerProvider(m.provider, {
				baseUrl: m.baseUrl,
				apiKey: "faux-key",
				api: faux.api,
				models: faux.models.map((x) => ({
					id: x.id,
					name: x.name,
					api: x.api,
					reasoning: x.reasoning,
					input: x.input,
					cost: x.cost,
					contextWindow: x.contextWindow,
					maxTokens: x.maxTokens,
				})),
			});
		},
	],
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
});
await resourceLoader.reload();

const { session } = await createAgentSession({
	cwd: join(project, "src"),
	agentDir: work,
	modelRuntime,
	model: faux.getModel(),
	resourceLoader,
	sessionManager: SessionManager.inMemory(),
	settingsManager: SettingsManager.inMemory(),
});
await session.bindExtensions({});

try {
	// 1. The model flags an item: it lands in the per-project file.
	await session.prompt("Wire up Stripe checkout");
	let { file, json } = readInbox();
	assert.ok(file.includes("healthforge-"), "file named after the git root, not src/");
	assert.equal(json.items.length, 1);
	assert.equal(json.items[0].title, "Add STRIPE_SECRET_KEY to .env.local");
	assert.equal(json.items[0].source, "pi");
	assert.equal(json.items[0].blocking, true);

	// 2. Claude Code adds an item to the same file (as its mod would).
	json.items.push({ ...json.items[0], id: "from-claude", n: 2, title: "Approve the DB migration", kind: "decision", source: "claude-code", blocking: false });
	json.nextN = 3;
	writeFileSync(file, JSON.stringify(json, null, 2));

	// 3. On the next prompt the model is told what is open, both agents' items.
	await session.prompt("I set the key");
	const told = seen.join("\n");
	assert.ok(told.includes("<user_inbox>"), "the open items reached the model");
	assert.ok(told.includes("#2 [decision] Approve the DB migration"), "it sees Claude Code's item");
	({ json } = readInbox());
	assert.equal(json.items.find((i: { n: number }) => i.n === 1).status, "done");
	assert.equal(json.items.find((i: { n: number }) => i.n === 1).note, "key is set");

	// 4. The human's /done closes the other one.
	await session.prompt("/done 2");
	({ json } = readInbox());
	assert.equal(json.items.find((i: { n: number }) => i.n === 2).status, "done");
	assert.equal(json.items.find((i: { n: number }) => i.n === 2).closedBy, "you");

	console.log("pi smoke test passed:", file);
} finally {
	session.dispose();
	faux.unregister();
}

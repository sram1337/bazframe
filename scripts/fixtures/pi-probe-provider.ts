import { appendFileSync } from "node:fs";
import * as piAi from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ProbeMessage = { role: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
type ProbeContext = { systemPrompt?: string; messages: readonly ProbeMessage[] };

function probeSystemPrompt(context: ProbeContext): string {
	if (typeof context.systemPrompt === "string") return context.systemPrompt;
	if (!Array.isArray(context.messages) || !("getCurrentSystemPrompt" in piAi)
		|| typeof piAi.getCurrentSystemPrompt !== "function") {
		throw new Error("Pi probe requires a legacy system prompt or transcript prompt API.");
	}
	const prompt: unknown = piAi.getCurrentSystemPrompt(context.messages);
	if (typeof prompt !== "string") throw new Error("Pi transcript prompt API did not return a string.");
	return prompt;
}

function streamProbe(
	model: Model<Api>,
	context: ProbeContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = piAi.createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	queueMicrotask(() => {
		try {
			const capturePath = process.env.BAZFRAME_PI_PROBE_CAPTURE;
			if (capturePath === undefined) throw new Error("BAZFRAME_PI_PROBE_CAPTURE is required.");
			const systemPrompt = probeSystemPrompt(context);
			appendFileSync(capturePath, `${JSON.stringify({
				cwd: process.cwd(),
				systemPrompt,
				skills: systemPrompt.match(/<skill>/g)?.length ?? 0,
				...(process.env.BAZFRAME_PI_PROBE_MESSAGES === "1" ? { messages: context.messages } : {}),
			})}\n`);

			stream.push({ type: "start", partial: output });
			// Opt-in single-resource fixture only. The journey admits this exact benign
			// snapshot path before launch; Pi's installed read tool executes the call.
			// Never read the file here or manufacture a tool-result receipt.
			const resource = process.env.BAZFRAME_PI_PROBE_READ;
			if (resource !== undefined) {
				if (process.env.BAZFRAME_PI_PROBE_MESSAGES !== "1" || !resource) throw new Error("Read probe requires explicit capture and resource admission.");
				const results = context.messages.filter(message => message.role === "toolResult");
				if (results.length === 0) {
					const call = { type: "toolCall" as const, id: "bazframe-support-read", name: "read", arguments: { path: resource } };
					output.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
					stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: output });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
					stream.end();
					return;
				}
				if (results.length !== 1 || results[0].toolCallId !== "bazframe-support-read" || results[0].toolName !== "read" || results[0].isError !== false) {
					throw new Error("Read probe requires one successful correlated Pi tool result.");
				}
			}
			const block = { type: "text" as const, text: "probe-ok" };
			output.content.push(block);
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	});
	return stream;
}

export default function probeProvider(pi: ExtensionAPI): void {
	pi.registerProvider("bazframe-probe", {
		name: "Bazframe spike probe",
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "probe",
		api: "openai-completions",
		models: [
			{
				id: "probe",
				name: "Bazframe spike probe",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 1024,
			},
		],
		streamSimple: streamProbe,
	});
}

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

type ProbeContext = { systemPrompt?: string; messages: readonly { role: string }[] };

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
			})}\n`);

			stream.push({ type: "start", partial: output });
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

import { z } from "zod";
import type { Brief, CallResult, TranscriptTurn } from "./schemas.js";
import { OUTCOMES } from "./schemas.js";

export interface ExtractInput {
  brief: Brief;
  taskType: string;
  businessNumber: string;
  endReason: string | null;
  transcript: TranscriptTurn[];
  principal: string;
}

export type Extractor = (input: ExtractInput) => Promise<CallResult>;

const ResultSchema = z.object({
  outcome: z.enum(OUTCOMES).catch("other"),
  summary: z.string().min(1),
  details: z.record(z.string(), z.unknown()).catch({}),
  options: z
    .array(z.object({ label: z.string(), details: z.record(z.string(), z.unknown()).catch({}) }))
    .catch([]),
  follow_up_needed: z.boolean().catch(false),
  follow_up_reason: z.string().nullable().catch(null),
});

const SYSTEM = `You turn a phone call transcript into a structured result for a personal assistant.
Return only a JSON object with exactly these keys:
- outcome: one of ${OUTCOMES.map((o) => `"${o}"`).join(", ")}.
  "booked" = the goal was fully achieved and confirmed (also use it for a successful inquiry where the answer was obtained).
  "options_offered" = the business offered alternatives that need the principal to choose.
  "not_available" = the business cannot help and offered no alternatives.
  "needs_user_decision" = something came up that the principal must decide (e.g. payment or deposit required, unexpected question).
  "refused" = the business declined to deal with an AI caller or hung up.
  "other" = anything else, including calls with no meaningful conversation.
- summary: one or two plain sentences the assistant can relay to the principal almost word for word. State only facts from the transcript.
- details: an object with the concrete facts agreed or learned (e.g. date "YYYY-MM-DD", time "HH:MM" 24h, party_size, name_for_booking, contact_number_used, opening hours, prices). Only include facts actually stated on the call.
- options: array of {label, details} for each alternative the business offered; empty array otherwise.
- follow_up_needed: boolean.
- follow_up_reason: short string or null.
Never invent facts. If the transcript is empty or unclear, say so in the summary and use "other".`;

export function openAiExtractor(opts: { apiKey: string; apiBase: string; model: string; fetchImpl?: typeof fetch }): Extractor {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (input) => {
    if (input.transcript.length === 0) return emptyResult(input.endReason);
    const transcriptText = input.transcript.map((t) => `[${t.at_seconds.toFixed(1)}s] ${t.speaker}: ${t.text}`).join("\n");
    const user = `Principal: ${input.principal}
Task type: ${input.taskType}
Business number: ${input.businessNumber}
Brief: ${JSON.stringify(input.brief)}
Agent's stated reason for ending the call: ${input.endReason ?? "not given (the other side may have hung up)"}

Transcript:
${transcriptText}`;
    const res = await doFetch(`${opts.apiBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`extraction request failed with HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("extraction response had no content");
    return ResultSchema.parse(JSON.parse(content));
  };
}

export function emptyResult(endReason: string | null): CallResult {
  return {
    outcome: "other",
    summary: "The call connected but no conversation was captured.",
    details: endReason ? { end_reason: endReason } : {},
    options: [],
    follow_up_needed: true,
    follow_up_reason: "No conversation was captured; check the transcript and decide whether to call again.",
  };
}

export function fallbackResult(error: string): CallResult {
  return {
    outcome: "other",
    summary: "The call finished, but the bridge could not summarize it automatically. Please read the transcript.",
    details: { extraction_error: error },
    options: [],
    follow_up_needed: true,
    follow_up_reason: "Automatic outcome extraction failed.",
  };
}

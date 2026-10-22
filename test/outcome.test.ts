import { describe, expect, it } from "vitest";
import { openAiExtractor } from "../src/outcome.js";
import { createBody } from "./helpers.js";

const input = {
  brief: createBody().brief as any,
  taskType: "restaurant_reservation",
  businessNumber: "+19025550123",
  endReason: "options_collected",
  principal: "Jainil Sevalia",
  transcript: [{ speaker: "business" as const, text: "We have 6:30 or 8:30.", at_seconds: 3 }],
};

const fakeFetch = (content: string, status = 200) =>
  (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch;

describe("outcome extraction", () => {
  it("normalizes model output into the result shape", async () => {
    const extract = openAiExtractor({
      apiKey: "k",
      apiBase: "http://x",
      model: "m",
      fetchImpl: fakeFetch(JSON.stringify({ outcome: "options_offered", summary: "They offered 6:30 or 8:30.", options: [{ label: "6:30 pm", details: { time: "18:30" } }] })),
    });
    expect(await extract(input)).toEqual({
      outcome: "options_offered",
      summary: "They offered 6:30 or 8:30.",
      details: {},
      options: [{ label: "6:30 pm", details: { time: "18:30" } }],
      follow_up_needed: false,
      follow_up_reason: null,
    });
  });

  it("coerces an unknown outcome to other", async () => {
    const extract = openAiExtractor({ apiKey: "k", apiBase: "http://x", model: "m", fetchImpl: fakeFetch('{"outcome":"great","summary":"ok"}') });
    expect((await extract(input)).outcome).toBe("other");
  });

  it("throws on HTTP errors so the caller can fall back", async () => {
    const extract = openAiExtractor({ apiKey: "k", apiBase: "http://x", model: "m", fetchImpl: fakeFetch("", 500) });
    await expect(extract(input)).rejects.toThrow("HTTP 500");
  });

  it("skips the model for an empty transcript", async () => {
    const extract = openAiExtractor({ apiKey: "k", apiBase: "http://x", model: "m", fetchImpl: (() => { throw new Error("should not call"); }) as any });
    expect((await extract({ ...input, transcript: [] })).outcome).toBe("other");
  });
});

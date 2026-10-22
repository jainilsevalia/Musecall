import { describe, expect, it } from "vitest";
import { AUTH, FORM_HEADERS, createBody, form, makeApp } from "./helpers.js";

async function createCall(ctx: Awaited<ReturnType<typeof makeApp>>, overrides: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({ method: "POST", url: "/v1/calls", headers: AUTH, payload: createBody(overrides) });
  await ctx.calls.settle();
  return res;
}

function status(ctx: Awaited<ReturnType<typeof makeApp>>, callId: string, params: Record<string, string>) {
  return ctx.app.inject({ method: "POST", url: `/twilio/status?call_id=${callId}`, headers: FORM_HEADERS, payload: form(params) });
}

describe("auth and health", () => {
  it("returns ok with the key and 401 without it", async () => {
    const ctx = await makeApp();
    expect((await ctx.app.inject({ url: "/v1/health", headers: AUTH })).json()).toEqual({ status: "ok" });
    expect((await ctx.app.inject({ url: "/v1/health" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ url: "/v1/health", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ url: "/v1/calls/cb_x", headers: { authorization: "Basic abc" } })).statusCode).toBe(401);
  });
});

describe("create call", () => {
  it("queues a call and dials once", async () => {
    const ctx = await makeApp();
    const res = await createCall(ctx);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "queued", call_id: expect.stringMatching(/^cb_/) });
    expect(ctx.telephony.placed).toHaveLength(1);
    expect(ctx.telephony.placed[0]).toMatchObject({ to: "+19025550123", from: "+19025550199", timeLimitSeconds: 315 });
    const call = (await ctx.app.inject({ url: `/v1/calls/${res.json().call_id}`, headers: AUTH })).json();
    expect(call.status).toBe("dialing");
    expect(call.twilio_call_sid).toMatch(/^CA/);
  });

  it("is idempotent on client_request_id", async () => {
    const ctx = await makeApp();
    const first = await createCall(ctx);
    const second = await createCall(ctx, { to: "+19025550999" });
    expect(second.statusCode).toBe(200);
    expect(second.json().call_id).toBe(first.json().call_id);
    expect(ctx.telephony.placed).toHaveLength(1);
  });

  it("rejects invalid requests with the error shape", async () => {
    const ctx = await makeApp();
    const res = await createCall(ctx, { to: "902-555-0123" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(res.json().error.message).toContain("to");
    const noBrief = await ctx.app.inject({ method: "POST", url: "/v1/calls", headers: AUTH, payload: { client_request_id: "x", to: "+19025550123" } });
    expect(noBrief.statusCode).toBe(400);
    expect(ctx.telephony.placed).toHaveLength(0);
  });

  it("refuses numbers outside the allowed prefixes", async () => {
    const ctx = await makeApp();
    const res = await createCall(ctx, { to: "+447700900123" });
    expect(res.statusCode).toBe(400);
  });

  it("limits concurrent active calls", async () => {
    const ctx = await makeApp({ cfg: { MAX_CONCURRENT_CALLS: "1" } });
    await createCall(ctx);
    const res = await createCall(ctx, { client_request_id: "genie-2" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("too_many_active_calls");
  });

  it("marks the call failed with a reason when Twilio rejects it", async () => {
    const ctx = await makeApp();
    ctx.telephony.failNext = { code: 21211, message: "Invalid 'To' Phone Number" };
    const res = await createCall(ctx);
    const call = (await ctx.app.inject({ url: `/v1/calls/${res.json().call_id}`, headers: AUTH })).json();
    expect(call.status).toBe("failed");
    expect(call.error).toEqual({ code: "twilio_21211", message: "Invalid 'To' Phone Number" });
  });
});

describe("call lifecycle via Twilio callbacks", () => {
  it("goes ringing → in_progress → completed with a result and history", async () => {
    const ctx = await makeApp();
    const id = (await createCall(ctx)).json().call_id;
    await status(ctx, id, { CallStatus: "ringing" });
    await status(ctx, id, { CallStatus: "in-progress" });
    ctx.store.addTurn(id, { speaker: "agent", text: "Hi, I am an AI assistant.", at_seconds: 1 });
    ctx.store.addTurn(id, { speaker: "business", text: "Sure, how many?", at_seconds: 4 });
    await status(ctx, id, { CallStatus: "completed", CallDuration: "112" });
    await ctx.calls.settle();

    const call = (await ctx.app.inject({ url: `/v1/calls/${id}`, headers: AUTH })).json();
    expect(call.status).toBe("completed");
    expect(call.duration_seconds).toBe(112);
    expect(call.result).toMatchObject({ outcome: "booked", summary: "Booked. 2 turns." });
    expect(call.status_history.map((h: any) => h.status)).toEqual(["queued", "dialing", "ringing", "in_progress", "completed"]);

    const t = (await ctx.app.inject({ url: `/v1/calls/${id}/transcript`, headers: AUTH })).json();
    expect(t.turns.map((x: any) => x.speaker)).toEqual(["agent", "business"]);
  });

  it("does not expose a result before extraction finishes and survives extractor failure", async () => {
    const ctx = await makeApp({
      extract: async () => {
        throw new Error("boom");
      },
    });
    const id = (await createCall(ctx)).json().call_id;
    await status(ctx, id, { CallStatus: "in-progress" });
    await status(ctx, id, { CallStatus: "completed", CallDuration: "10" });
    await ctx.calls.settle();
    const call = (await ctx.app.inject({ url: `/v1/calls/${id}`, headers: AUTH })).json();
    expect(call.status).toBe("completed");
    expect(call.result.outcome).toBe("other");
    expect(call.result.follow_up_needed).toBe(true);
  });

  it.each([
    ["no-answer", "no_answer"],
    ["busy", "busy"],
    ["failed", "failed"],
  ])("maps Twilio %s to %s and never retries", async (tw, ours) => {
    const ctx = await makeApp();
    const id = (await createCall(ctx)).json().call_id;
    await status(ctx, id, { CallStatus: tw, SipResponseCode: "404" });
    await status(ctx, id, { CallStatus: "completed" }); // late/duplicate callbacks must not change a terminal status
    await ctx.calls.settle();
    const call = (await ctx.app.inject({ url: `/v1/calls/${id}`, headers: AUTH })).json();
    expect(call.status).toBe(ours);
    expect(call.result).toBeNull();
    expect(ctx.telephony.placed).toHaveLength(1);
    if (ours === "failed") expect(call.error.code).toBe("sip_404");
  });

  it("hangs up on an answering machine and reports voicemail (sync AMD)", async () => {
    const ctx = await makeApp();
    const id = (await createCall(ctx)).json().call_id;
    const twiml = await ctx.app.inject({ method: "POST", url: `/twilio/voice?call_id=${id}`, headers: FORM_HEADERS, payload: form({ AnsweredBy: "machine_start" }) });
    expect(twiml.body).toContain("<Hangup/>");
    await status(ctx, id, { CallStatus: "in-progress" });
    await status(ctx, id, { CallStatus: "completed", CallDuration: "3" });
    await ctx.calls.settle();
    expect((await ctx.app.inject({ url: `/v1/calls/${id}`, headers: AUTH })).json().status).toBe("voicemail");
  });

  it("returns stream TwiML with call id and token for a human", async () => {
    const ctx = await makeApp();
    const id = (await createCall(ctx)).json().call_id;
    const twiml = await ctx.app.inject({ method: "POST", url: `/twilio/voice?call_id=${id}`, headers: FORM_HEADERS, payload: form({ AnsweredBy: "human" }) });
    expect(twiml.headers["content-type"]).toContain("text/xml");
    expect(twiml.body).toContain('<Stream url="wss://calls.example.com/twilio/media">');
    expect(twiml.body).toContain(`<Parameter name="call_id" value="${id}"/>`);
    expect(twiml.body).toMatch(/<Parameter name="token" value="[0-9a-f]{64}"\/>/);
  });

  it("rejects webhooks with a bad Twilio signature", async () => {
    const ctx = await makeApp();
    const id = (await createCall(ctx)).json().call_id;
    ctx.telephony.signaturesValid = false;
    const res = await status(ctx, id, { CallStatus: "in-progress" });
    expect(res.statusCode).toBe(403);
    expect(ctx.store.get(id)!.status).toBe("dialing");
  });

  it("cancels an active call", async () => {
    const ctx = await makeApp();
    const id = (await createCall(ctx)).json().call_id;
    await status(ctx, id, { CallStatus: "ringing" });
    const res = await ctx.app.inject({ method: "POST", url: `/v1/calls/${id}/cancel`, headers: AUTH });
    expect(res.json()).toEqual({ call_id: id, status: "canceled" });
    expect(ctx.telephony.ended).toHaveLength(1);
    await status(ctx, id, { CallStatus: "canceled" });
    expect(ctx.store.get(id)!.status).toBe("canceled");
  });

  it("returns 404 for unknown calls", async () => {
    const ctx = await makeApp();
    expect((await ctx.app.inject({ url: "/v1/calls/cb_nope", headers: AUTH })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: "/v1/calls/cb_nope/transcript", headers: AUTH })).statusCode).toBe(404);
  });
});

describe("retention", () => {
  it("purges calls older than the retention window", async () => {
    const ctx = await makeApp();
    const id = (await createCall(ctx)).json().call_id;
    ctx.store.db.prepare("UPDATE calls SET created_at = '2020-01-01T00:00:00Z'").run();
    expect(ctx.store.purgeOlderThan(30)).toBe(1);
    expect(ctx.store.get(id)).toBeUndefined();
  });
});

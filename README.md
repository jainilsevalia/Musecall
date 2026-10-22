# Genie Call Bridge

Outbound calling bridge for **Genie** (Jainil's assistant in Muse). Genie sends a confirmed call brief over a small HTTP API. The bridge places the call from Jainil's own Twilio number, and an OpenAI Realtime voice agent holds the conversation within the rules of the brief. Genie then polls for a structured result and the transcript.

This implements *Genie Outbound Calling Bridge: Project Plan and Build Spec, v1* (outbound only).

```
Genie (Muse connector) ──HTTPS + Bearer key──▶ /v1/*            (this bridge)
                                                 │
                                   Twilio Calls API (create, hang up)
                                                 ▼
 Business phone ◀──PSTN──▶ Twilio ──webhooks──▶ /twilio/voice, /twilio/status, /twilio/amd
                                   └─Media Stream (WSS, μ-law 8 kHz)─▶ /twilio/media ◀─WSS─▶ OpenAI Realtime
```

Audio path: **option A** from the spec (Twilio Media Streams ↔ OpenAI Realtime). Both sides use G.711 μ-law 8 kHz (`audio/pcmu`), so audio passes through without transcoding. Turn taking uses `server_vad` with barge-in: when the business starts speaking, Twilio playback is cleared and the model's item is truncated. Input transcription is enabled to build the transcript.

## API (spec section 6)

Every `/v1/*` request needs `Authorization: Bearer <API_KEY>`. All bodies are JSON. Errors look like `{ "error": { "code": "...", "message": "..." } }`.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/health` | `{"status":"ok"}`; 401 without a valid key |
| POST | `/v1/calls` | 202 `{call_id, status:"queued"}`. **Idempotent** on `client_request_id`: a repeat returns 200 with the existing call and never dials again |
| GET | `/v1/calls/{call_id}` | Call state; `result` is set once `status` is `completed` |
| GET | `/v1/calls/{call_id}/transcript` | `{turns:[{speaker, text, at_seconds}], recording_url:null}` |
| POST | `/v1/calls/{call_id}/cancel` | Ends a queued or live call and sets `canceled` |
| GET | `/healthz` | Unauthenticated liveness probe for the host |

Statuses: `queued`, `dialing`, `ringing`, `in_progress`, then one terminal status: `completed`, `busy`, `no_answer`, `voicemail`, `failed`, `canceled`. A call stays `in_progress` until its result has been extracted, so `completed` always has a `result`.

### Where the shapes differ from the spec (additive only)

- A duplicate `POST /v1/calls` returns **200** (not 202). The body shape is the same.
- `GET /v1/calls/{id}` also returns `task_type`, `created_at`, `end_reason` (the agent's reason for hanging up, e.g. `goal_reached`, `voicemail`, `max_duration`), `error` (`{code, message}` on `failed`, e.g. `twilio_21211` or `sip_404`), and `status_history` (`[{status, at}]`).
- The transcript response also includes `call_id` and `status`.
- `409 too_many_active_calls` when `MAX_CONCURRENT_CALLS` (default 1) are already active.
- `400` if `to` is outside `ALLOWED_TO_PREFIXES` (default `+1`) or `max_duration_seconds` is over `MAX_DURATION_CAP_SECONDS`.
- `brief` is validated (`goal` and `opening_line` are required). Unknown brief fields are passed to the agent as extra context.

### Worked example

> TODO: replace with a real create request and the final `GET /v1/calls/{id}` response from test call 1, after the first live call.

```bash
curl -s https://calls.example.com/v1/calls \
  -H "Authorization: Bearer $GENIE_KEY" -H "content-type: application/json" \
  -d '{
    "client_request_id": "genie-2026-10-22-0001",
    "to": "+19025550123",
    "task_type": "restaurant_reservation",
    "max_duration_seconds": 300,
    "brief": {
      "goal": "Reserve a table for two on Friday 2026-10-23 at 7:00 pm.",
      "business_name": "Example Bistro",
      "opening_line": "Hi, I am an AI assistant calling on behalf of Jainil Sevalia. I am hoping to reserve a table for two on Friday at 7 pm.",
      "identity": {"name_for_booking": "Jainil Sevalia", "callback_number": "+19025550100", "share_callback_number": true},
      "constraints": {"party_size": 2, "date": "2026-10-23", "target_time": "19:00", "acceptable_times": ["18:30","19:00","19:30","20:00"], "timezone": "America/Halifax"},
      "hard_limits": ["Do not accept a time that is not in acceptable_times."],
      "if_unavailable": "Ask which times are available that evening, collect them as options, thank them, and end the call.",
      "if_unexpected_question": "Say you will confirm with Jainil and call back. Do not guess.",
      "closing": "Repeat the final booking details back, thank them, and end the call."
    }
  }'
```

## How a call runs

1. `POST /v1/calls` stores the call (SQLite) and places it through Twilio with status callbacks, `timeLimit = max_duration_seconds + 15`, and answering machine detection.
2. On answer, Twilio fetches `/twilio/voice`. A machine gets `<Hangup/>`, which ends the call as `voicemail`. A human gets `<Connect><Stream>` with `call_id` and an HMAC stream token as `<Parameter>`s.
3. `/twilio/media` checks the token, opens the Realtime session with the brief merged into a short fixed system prompt (`src/prompt.ts`), and the agent speaks first with the brief's `opening_line`.
4. The agent calls the `end_call` tool after its goodbye. The bridge waits for the goodbye audio to finish playing (Twilio marks), then hangs up. At `max_duration_seconds - 20` the agent is told to wrap up, and at `max_duration_seconds` the bridge hangs up.
5. On Twilio's `completed` callback, the bridge flushes pending transcriptions, then runs a small model pass (`OPENAI_EXTRACTION_MODEL`) over the transcript to build `result`, and sets `completed`. If extraction fails, `result.outcome` is `other` with `follow_up_needed: true`.

### Voicemail (`AMD_MODE`)

- `sync` (default): Twilio decides human vs machine *before* audio connects. The agent never speaks to a machine. The trade-off is a short pause (about 2–4 s) after a human says hello.
- `async`: audio connects immediately and the agent waits for the callee to speak first. The call is hung up when Twilio's AMD or the agent itself detects a machine. Faster for humans, but a small risk that the opening line is spoken to a machine.
- `off`: the agent's own `end_call(voicemail)` judgement only.

The default on voicemail is always to hang up without leaving a message. Leaving messages (spec section 12) is not implemented.

## Safety rules enforced in code

- Every system prompt requires AI disclosure, bans payment and card details, bans sharing the home address, and bans inventing information. The brief's `hard_limits` are appended.
- The callback number is offered only when `identity.share_callback_number` is true.
- Calls are never retried automatically. `busy`, `no_answer` and `failed` are terminal.
- Recording is off (`record: false`), and `recording_url` is always `null`.
- The API key is stored only as a SHA-256 digest (`BRIDGE_API_KEY_SHA256`) and compared in constant time. `Authorization` and `X-Twilio-Signature` are redacted from logs. Request logs carry `call_id` and `client_request_id`.
- Twilio webhooks are verified with `X-Twilio-Signature`. Media streams are verified with a per-call HMAC token.
- Retention: calls, transcripts and status history are deleted `RETENTION_DAYS` (default **30**) after the call ends. The purge runs hourly.

## Setup

Requirements: Node 22+, a **paid** Twilio account with a voice-capable number (Jainil's own account, not the client's), and an OpenAI API key with Realtime access.

```bash
npm ci
cp .env.example .env        # fill in values; never commit .env
npm run issue-key           # prints the Genie key once + BRIDGE_API_KEY_SHA256 for .env
npm test
npm run dev                 # or: npm run build && npm start
```

`npm run issue-key` prints the plaintext key to your terminal only. Paste it into the Muse secure page when Genie sends the link. Do not save it anywhere, and do not send it in chat or email.

For local calls, expose the port with an HTTPS tunnel and set `PUBLIC_BASE_URL` to the tunnel URL. If the tunnel rewrites URLs and breaks signatures, set `TWILIO_VALIDATE_SIGNATURES=false`, but only for local testing.

### Deploy (Fly.io template included)

The bridge must be a single always-on instance: SQLite lives on a volume, and live calls hold WebSockets.

```bash
fly launch --no-deploy --copy-config      # set app name / region in fly.toml
fly volumes create bridge_data --size 1
fly secrets set PUBLIC_BASE_URL=https://<host> BRIDGE_API_KEY_SHA256=... STREAM_TOKEN_SECRET=... \
  TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_DEFAULT_FROM=+1... \
  OPENAI_API_KEY=... PRINCIPAL_NAME="Jainil Sevalia"
fly deploy
```

Any Docker host with a persistent disk and WebSocket support works too (see `Dockerfile`). No Twilio console webhook setup is needed: the bridge passes all callback URLs when it creates each call.

## Acceptance test plan (spec section 11)

| Test | Covered by |
|---|---|
| Health ok with key, 401 without | `test/api.test.ts` + live check |
| Test call 1: call Jainil's mobile, AI disclosure, clean end, status transitions + transcript | live; status history via `status_history` |
| Test call 2: duplicate `client_request_id` → same `call_id`, no second dial | `test/api.test.ts` + live |
| Test call 3: real low-stakes inquiry (opening hours), answer in `details` | live |
| No answer → `no_answer`, wrong number → `failed` with reason, no retries | `test/api.test.ts` + live |

Automated tests (`npm test`) use a fake Twilio client and a fake Realtime WebSocket server. They cover audio relay, barge-in truncation, transcript ordering, hang up after the goodbye plays, and voicemail handling.

## Layout

```
src/index.ts      entrypoint, retention purge
src/app.ts        HTTP routes (API + Twilio webhooks + media WS)
src/calls.ts      call lifecycle: create/dial, status callbacks, cancel, finalize
src/media.ts      Twilio Media Stream ↔ OpenAI Realtime bridge
src/prompt.ts     system prompt template + end_call tool
src/outcome.ts    transcript → result extraction
src/telephony.ts  Twilio client wrapper + status mapping
src/db.ts         SQLite store
src/schemas.ts    request/brief validation and shared types
src/auth.ts       API key + stream token checks
```

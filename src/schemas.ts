import { z } from "zod";

export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "must be an E.164 phone number, e.g. +19025550123");

// The brief is Genie's per-call source of truth (spec section 7). Known fields are typed,
// unknown extra fields are kept so Genie can add context without a bridge release.
export const BriefSchema = z.looseObject({
  goal: z.string().min(1).max(2000),
  business_name: z.string().min(1).max(200).optional(),
  opening_line: z.string().min(1).max(1000),
  identity: z
    .looseObject({
      name_for_booking: z.string().max(200).optional(),
      callback_number: E164.optional(),
      share_callback_number: z.boolean().default(false),
    })
    .optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  hard_limits: z.array(z.string().max(500)).max(30).default([]),
  if_unavailable: z.string().max(1000).optional(),
  if_unexpected_question: z.string().max(1000).optional(),
  closing: z.string().max(1000).optional(),
});

export type Brief = z.infer<typeof BriefSchema>;

export const CreateCallSchema = z.object({
  client_request_id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\w.:-]+$/, "may contain letters, digits, '_', '-', '.', ':'"),
  to: E164,
  from: E164.optional(),
  task_type: z.string().min(1).max(100),
  language: z.string().min(2).max(35).default("en"),
  max_duration_seconds: z.number().int().min(30).max(3600).default(300),
  brief: BriefSchema,
});

export type CreateCallRequest = z.infer<typeof CreateCallSchema>;

export const CALL_STATUSES = [
  "queued",
  "dialing",
  "ringing",
  "in_progress",
  "completed",
  "busy",
  "no_answer",
  "voicemail",
  "failed",
  "canceled",
] as const;

export type CallStatus = (typeof CALL_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set([
  "completed",
  "busy",
  "no_answer",
  "voicemail",
  "failed",
  "canceled",
]);

export const OUTCOMES = ["booked", "options_offered", "not_available", "needs_user_decision", "refused", "other"] as const;

export interface CallResult {
  outcome: (typeof OUTCOMES)[number];
  summary: string;
  details: Record<string, unknown>;
  options: { label: string; details: Record<string, unknown> }[];
  follow_up_needed: boolean;
  follow_up_reason: string | null;
}

export interface TranscriptTurn {
  speaker: "agent" | "business" | "system";
  text: string;
  at_seconds: number;
}

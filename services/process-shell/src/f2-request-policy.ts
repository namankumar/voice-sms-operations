import { z } from "zod";

export const fullExecutableCapabilitySchema = z.enum([
  "appointment_details", "appointment_schedule", "appointment_reschedule", "appointment_attendance_confirm",
  "referral_status", "billing_balance", "office_address", "approved_practice_information",
]);
export const fullCapabilitySchema = z.enum([...fullExecutableCapabilitySchema.options, "human_request", "clinical", "unsupported", "uncertain"]);
export type FullCapability = z.infer<typeof fullCapabilitySchema>;
export const patientStatusSchema = z.enum(["established", "new", "unknown"]);

/** Intent is a model proposal; patient status and source remain explicit, not inferred from caller ID. */
export const fullRequestProposalSchema = z.object({
  capability: fullCapabilitySchema,
  patientStatus: patientStatusSchema,
  schedulingKind: z.enum(["office_visit", "procedure", "uncertain", "not_applicable"]),
  knowledgeTopic: z.enum(["address", "demo_way_directions", "sample_city_address", "locations", "directions", "parking", "hours", "other", "not_applicable"]),
}).strict().superRefine((value, context) => {
  const scheduling = value.capability === "appointment_schedule" || value.capability === "appointment_reschedule";
  if (scheduling === (value.schedulingKind === "not_applicable")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "scheduling_kind_mismatch" });
  }
  const publicKnowledge = value.capability === "office_address" || value.capability === "approved_practice_information";
  if ((publicKnowledge && value.knowledgeTopic === "not_applicable")
    || (!publicKnowledge && value.knowledgeTopic !== "not_applicable"
      && !(value.capability === "appointment_details" && value.knowledgeTopic === "directions"))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "knowledge_topic_mismatch" });
  }
  if (value.capability === "office_address" && value.knowledgeTopic !== "address") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "office_address_topic_mismatch" });
  }
  if (value.knowledgeTopic === "directions" && value.capability !== "appointment_details") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "appointment_directions_topic_mismatch" });
  }
  if (value.capability === "appointment_details" && !["directions", "not_applicable"].includes(value.knowledgeTopic)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "appointment_details_topic_mismatch" });
  }
});
export type FullRequestProposal = z.infer<typeof fullRequestProposalSchema>;

export type FullRequestDecision =
  | { kind: "handoff"; reason: "explicit_person" | "clinical" | "new_patient" | "unsupported" | "procedure_requires_staff" }
  | { kind: "clarify"; field: "intent" | "patient_status" | "scheduling_kind" }
  | { kind: "public_lookup"; topic: "address" | "demo_way_directions" | "sample_city_address" | "locations" | "parking" | "hours" | "other" }
  | { kind: "protected_tool"; capability: "appointment_details" | "appointment_schedule" | "appointment_reschedule" | "appointment_attendance_confirm" | "referral_status" | "billing_balance"; requiresIdentity: true };

/** This chooses a capability, never authorizes disclosure or commits an action. */
export function decideFullRequest(raw: FullRequestProposal): FullRequestDecision {
  const proposal = fullRequestProposalSchema.parse(raw);
  if (proposal.capability === "human_request") return { kind: "handoff", reason: "explicit_person" };
  if (proposal.capability === "clinical") return { kind: "handoff", reason: "clinical" };
  if (proposal.capability === "office_address" || proposal.capability === "approved_practice_information") {
    if (proposal.knowledgeTopic === "not_applicable" || proposal.knowledgeTopic === "directions") throw new Error("knowledge_topic_missing");
    return { kind: "public_lookup", topic: proposal.knowledgeTopic };
  }
  if (proposal.capability === "unsupported") return { kind: "handoff", reason: "unsupported" };
  if (proposal.capability === "uncertain") return { kind: "clarify", field: "intent" };
  if (proposal.schedulingKind === "procedure") return { kind: "handoff", reason: "procedure_requires_staff" };
  if (proposal.patientStatus === "new") return { kind: "handoff", reason: "new_patient" };
  if (proposal.patientStatus === "unknown") return { kind: "clarify", field: "patient_status" };
  // An existing appointment's type can be checked from the verified record.
  if (proposal.schedulingKind === "uncertain" && proposal.capability !== "appointment_reschedule") return { kind: "clarify", field: "scheduling_kind" };
  return { kind: "protected_tool", capability: proposal.capability, requiresIdentity: true };
}

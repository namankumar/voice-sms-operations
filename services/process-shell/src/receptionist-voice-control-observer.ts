import { createHmac } from "node:crypto";

export const startupStages = ["prompt", "accept", "connect", "session_start", "heartbeat", "buffer_drain"] as const;
export const startupErrors = ["openai_sideband_connect_timeout", "openai_sideband_connect_failed", "openai_voice_prompt_invalid",
  "openai_sideband_closed", "openai_sideband_payload_too_large", "openai_sideband_send_failed", "openai_sideband_send_timeout",
  "openai_sideband_send_unknown", "other"] as const;
export const voiceControlEvents = ["session_config", "speech_started", "speech_stopped", "transcript_finalized", "transcript_persisted", "transcript_timeout", "transcript_empty", "transcript_discarded", "speech_resumed", "speech_contained", "response_created", "response_done", "audio_started", "audio_stopped", "audio_cleared", "opening_transcript", "callback_close", "tool_result", "provider_failure", "control_failure"] as const;
export const voiceControlToolNames = ["propose_full_request", "propose_no_action", "propose_side_question", "propose_identity_factor", "propose_identity_factors",
  "propose_slot_selection", "propose_exact_consent", "propose_full_interrupt", "propose_f2_callback_capture",
  "propose_f2_callback_confirm", "propose_f2_callback_back", "propose_callback_dialogue", "propose_slot_withdrawal", "propose_receptionist_intent", "propose_receptionist_public_faq", "propose_receptionist_emergency", "propose_receptionist_capture", "propose_callback_answer", "propose_receptionist_dialogue", "other"] as const;
export const voiceControlResultKinds = ["no_action", "side_question", "question", "identity", "read", "appointment_offered", "appointment_selected", "knowledge",
  "knowledge_unknown", "handoff", "interrupt", "callback_captured", "sms_consent_delegated", "voice_consent_delegated",
  "obsolete", "rejected", "invalid_output", "callback_paused", "callback_dialogue", "appointment_withdrawn"] as const;
export const voiceControlRejectReasons = ["no_action_not_social", "context_unavailable", "invalid_control_tool", "exact_consent_not_pending", "handoff_transition_rejected",
  "handoff_request_transition_rejected", "execution_unavailable", "control_tool_unavailable", "identity_factor_not_stated",
  "callback_message_not_stated", "side_question_not_supported", "slot_selection_unavailable", "identity_value_unclear", "identity_source_mismatch", "read_authority_unavailable",
  "callback_name_invalid", "callback_number_invalid", "callback_capture_not_pending",
  "callback_capture_transition_rejected", "callback_dialogue_not_pending", "callback_tool_not_allowed", "interrupt_not_caller_supported", "slot_withdrawal_not_pending", "slot_withdrawal_transition_rejected", "other"] as const;
export const voiceControlOwnerships = ["current", "stale", "unowned"] as const;
export const voiceControlTranscriptDispositions = ["finalized", "missing"] as const;
export const voiceControlPendingQuestionKinds = ["none", "callback_number", "general", "name", "message", "callback_number_entry", "patient_status",
  "identity_dob", "identity_zip", "slot_selection", "appointment_consent", "attendance_consent", "request_clarification"] as const;
export const voiceControlIdentityFactors = ["date_of_birth", "zip"] as const;
export const voiceControlFailureClasses = ["provider_event", "sideband_error", "sideband_close", "response_failed", "transcription_failed", "opening_audio_timeout", "control_no_tool", "control_timeout", "transcript_persist_failed", "transcript_recovery_failed", "tool_execution_failed", "tool_continuation_timeout", "tool_continuation_rejected", "continuation_request_failed", "monitor_failure", "runtime_event_exception", "runtime_accept_exception", "fence_question_snapshot", "fence_barge_in", "fence_begin_turn"] as const;
export const voiceControlOperationOutcomes = ["failed", "unknown"] as const;
export const voiceControlGatewayOutcomes = ["accepted", "rejected", "not_invoked", "malformed", "unbound", "stale_ignored"] as const;
export const voiceControlIntentRejectStages = ["intent_schema", "intent_recipient", "other"] as const;
export const voiceControlGatewayRejectCodes = ["tool_not_allowed", "invalid_arguments", "source_not_current", "context_stale", "stale_revision", "question_not_pending", "confirmation_not_given", "transition_rejected", "invocation_conflict", "public_faq_unavailable", "other"] as const;
export const voiceControlOperationCauses = ["deadline", "recovery_started"] as const;
export const voiceControlCloseStages = ["candidate", "transcript_matched", "response_completed", "audio_started", "audio_stopped", "canceled", "intent_recorded", "intent_failed", "hangup_requested", "hangup_unknown", "exit_prompt", "exit_current_read", "initial_read", "intent_write", "final_read"] as const;
export const voiceControlCloseTimingStages = ["exit_prompt", "exit_current_read", "initial_read", "intent_write", "final_read"] as const;
const MAX_CLOSE_DURATION_MS = 60_000;
export const voiceControlAudioBoundaryOutcomes = ["accepted", "missing_response_id", "invalid_event_id", "missing_start", "missing_response", "response_incomplete", "stale_owner", "multiple_output_items"] as const;

export type VoiceControlTrace = Readonly<{
  event: typeof voiceControlEvents[number];
  inputItemId?: string;
  outputItemId?: string;
  sourceItemId?: string;
  responseId?: string;
  toolName?: typeof voiceControlToolNames[number];
  resultKind?: typeof voiceControlResultKinds[number];
  rejectReason?: typeof voiceControlRejectReasons[number];
  ownership?: typeof voiceControlOwnerships[number];
  transcriptDisposition?: typeof voiceControlTranscriptDispositions[number];
  controlOnly?: boolean;
  pendingQuestionKind?: typeof voiceControlPendingQuestionKinds[number];
  failureClass?: typeof voiceControlFailureClasses[number];
  operationOutcome?: typeof voiceControlOperationOutcomes[number];
  gatewayOutcome?: typeof voiceControlGatewayOutcomes[number];
  gatewayRejectCode?: typeof voiceControlGatewayRejectCodes[number];
  intentRejectStage?: typeof voiceControlIntentRejectStages[number];
  operationCause?: typeof voiceControlOperationCauses[number];
  vadCreatesResponse?: boolean | null;
  vadInterruptsResponse?: boolean | null;
  closeStage?: typeof voiceControlCloseStages[number];
  durationMs?: number;
  audioBoundaryOutcome?: typeof voiceControlAudioBoundaryOutcomes[number];
  openingNamePresent?: boolean;
  startupStage?: typeof startupStages[number];
  startupError?: typeof startupErrors[number];
  identityRejection?: VoiceControlIdentityRejectionDiagnostic;
}>;

/** Collapse an untrusted provider tool name to a fixed diagnostic category. */
export function projectVoiceControlToolName(toolName: string): typeof voiceControlToolNames[number] {
  return voiceControlToolNames.includes(toolName as typeof voiceControlToolNames[number])
    ? toolName as typeof voiceControlToolNames[number] : "other";
}

/** Fixed diagnostic categories only; identity values and caller text never cross this boundary. */
export type VoiceControlIdentityRejectionDiagnostic = Readonly<{
  selectedFactors: readonly (typeof voiceControlIdentityFactors[number])[];
  pendingQuestionKind: typeof voiceControlPendingQuestionKinds[number];
  sourceHasDateOfBirth: boolean;
  sourceHasZip: boolean;
}>;

/** Project untrusted tool output into fixed categories, never logging model arguments or result content. */
export function projectVoiceToolResultTrace(responseId: string, toolName: string, output: unknown, identityRejection?: unknown): VoiceControlTrace {
  const result = output !== null && typeof output === "object" && "kind" in output && output.kind === "f2_turn"
    && "result" in output && output.result !== null && typeof output.result === "object" ? output.result : null;
  const kind: typeof voiceControlResultKinds[number] = result !== null && "kind" in result && typeof result.kind === "string" && voiceControlResultKinds.includes(result.kind as typeof voiceControlResultKinds[number])
    ? result.kind as typeof voiceControlResultKinds[number] : "invalid_output";
  const reason: typeof voiceControlRejectReasons[number] = kind === "rejected" && result !== null && "reason" in result && typeof result.reason === "string"
    && voiceControlRejectReasons.includes(result.reason as typeof voiceControlRejectReasons[number]) ? result.reason as typeof voiceControlRejectReasons[number] : "other";
  const safeToolName = projectVoiceControlToolName(toolName);
  const diagnostic = kind === "rejected" && (safeToolName === "propose_identity_factor" || safeToolName === "propose_identity_factors")
    ? parseIdentityRejectionDiagnostic(identityRejection) : undefined;
  return { event: "tool_result", responseId, toolName: safeToolName, resultKind: kind,
    ...(kind === "rejected" ? { rejectReason: reason } : {}), ...(diagnostic === undefined ? {} : { identityRejection: diagnostic }) };
}

function parseIdentityRejectionDiagnostic(value: unknown): VoiceControlIdentityRejectionDiagnostic | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<VoiceControlIdentityRejectionDiagnostic>;
  const selectedFactors = candidate.selectedFactors;
  if (!Array.isArray(selectedFactors) || selectedFactors.length < 1 || selectedFactors.length > 2
    || !selectedFactors.every((factor) => voiceControlIdentityFactors.includes(factor as typeof voiceControlIdentityFactors[number]))
    || new Set(selectedFactors).size !== selectedFactors.length
    || !voiceControlPendingQuestionKinds.includes(candidate.pendingQuestionKind as typeof voiceControlPendingQuestionKinds[number])
    || typeof candidate.sourceHasDateOfBirth !== "boolean" || typeof candidate.sourceHasZip !== "boolean") return undefined;
  return { selectedFactors: selectedFactors as readonly (typeof voiceControlIdentityFactors[number])[],
    pendingQuestionKind: candidate.pendingQuestionKind as typeof voiceControlPendingQuestionKinds[number],
    sourceHasDateOfBirth: candidate.sourceHasDateOfBirth, sourceHasZip: candidate.sourceHasZip };
}

/** Control-plane evidence only. Never send provider payloads, transcripts, or raw identifiers to the log sink. */
export function createVoiceControlObserver(options: { secret: Buffer; sink(line: string): void; now?: () => Date }) {
  if (options.secret.length < 32) throw new Error("voice_control_observation_key_invalid");
  const secret = Buffer.from(options.secret);
  const hash = (domain: string, value: string) => createHmac("sha256", secret).update(JSON.stringify([domain, value])).digest("hex");
  return (context: { conversationId: string; callId: string }, trace: VoiceControlTrace): boolean => {
    const identityRejection = trace.identityRejection === undefined ? undefined : parseIdentityRejectionDiagnostic(trace.identityRejection);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(context.conversationId) || !/^[A-Za-z0-9_-]{1,200}$/.test(context.callId)
      || !voiceControlEvents.includes(trace.event)
      || trace.inputItemId !== undefined && (!/^[A-Za-z0-9_-]{1,200}$/.test(trace.inputItemId)
        || !["speech_started", "speech_stopped", "transcript_finalized", "transcript_persisted", "transcript_timeout", "transcript_empty", "transcript_discarded", "speech_resumed"].includes(trace.event))
      || trace.outputItemId !== undefined && (!/^[A-Za-z0-9_-]{1,200}$/.test(trace.outputItemId) || trace.event !== "speech_contained")
      || trace.event === "speech_contained" && (trace.outputItemId === undefined || trace.responseId === undefined)
      || trace.sourceItemId !== undefined && (!/^[A-Za-z0-9_-]{1,200}$/.test(trace.sourceItemId) || trace.event !== "tool_result")
      || trace.responseId !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(trace.responseId)
      || trace.toolName !== undefined && !voiceControlToolNames.includes(trace.toolName as typeof voiceControlToolNames[number])
      || trace.operationOutcome !== undefined && !voiceControlOperationOutcomes.includes(trace.operationOutcome as typeof voiceControlOperationOutcomes[number])
      || trace.operationCause !== undefined && !voiceControlOperationCauses.includes(trace.operationCause as typeof voiceControlOperationCauses[number])
      || trace.gatewayOutcome !== undefined && !voiceControlGatewayOutcomes.includes(trace.gatewayOutcome)
      || trace.intentRejectStage !== undefined && !voiceControlIntentRejectStages.includes(trace.intentRejectStage)
      || trace.intentRejectStage !== undefined && (trace.toolName !== "propose_receptionist_intent" || trace.gatewayOutcome !== "rejected")
      || trace.gatewayRejectCode !== undefined && !voiceControlGatewayRejectCodes.includes(trace.gatewayRejectCode)
      || trace.gatewayRejectCode !== undefined && trace.gatewayOutcome !== "rejected"
      || trace.gatewayOutcome !== undefined && trace.event !== "tool_result"
      || trace.resultKind !== undefined && !voiceControlResultKinds.includes(trace.resultKind as typeof voiceControlResultKinds[number])
      || trace.rejectReason !== undefined && !voiceControlRejectReasons.includes(trace.rejectReason as typeof voiceControlRejectReasons[number])
      || (trace.event === "tool_result" && (trace.responseId === undefined || trace.toolName === undefined || (trace.resultKind === undefined) === (trace.gatewayOutcome === undefined)))
      || (trace.event !== "tool_result" && trace.event !== "control_failure" && (trace.toolName !== undefined || trace.resultKind !== undefined || trace.rejectReason !== undefined))
      || trace.event === "control_failure" && (trace.resultKind !== undefined || trace.rejectReason !== undefined
        || (trace.toolName !== undefined || trace.operationOutcome !== undefined || trace.operationCause !== undefined) && trace.failureClass !== "tool_execution_failed"
        || trace.failureClass === "tool_execution_failed" && (trace.toolName === undefined || trace.operationOutcome === undefined
          || trace.operationOutcome === "unknown" && trace.operationCause === undefined
          || trace.operationOutcome !== "unknown" && trace.operationCause !== undefined))
      || trace.event !== "control_failure" && (trace.operationOutcome !== undefined || trace.operationCause !== undefined)
      || (trace.rejectReason !== undefined && trace.resultKind !== "rejected")
      || trace.identityRejection !== undefined && (trace.event !== "tool_result" || trace.resultKind !== "rejected"
        || (trace.toolName !== "propose_identity_factor" && trace.toolName !== "propose_identity_factors")
        || identityRejection === undefined)
      || trace.ownership !== undefined && !voiceControlOwnerships.includes(trace.ownership)
      || trace.transcriptDisposition !== undefined && !voiceControlTranscriptDispositions.includes(trace.transcriptDisposition)
      || trace.event === "transcript_finalized" && trace.inputItemId === undefined
      || trace.event === "transcript_discarded" && (trace.inputItemId === undefined || trace.ownership !== "stale" || trace.transcriptDisposition === undefined)
      || trace.event !== "transcript_discarded" && trace.transcriptDisposition !== undefined
      || trace.controlOnly !== undefined && typeof trace.controlOnly !== "boolean"
      || trace.pendingQuestionKind !== undefined && !voiceControlPendingQuestionKinds.includes(trace.pendingQuestionKind)
      || (["provider_failure", "control_failure"].includes(trace.event)) !== (trace.failureClass !== undefined)
      || trace.failureClass !== undefined && !voiceControlFailureClasses.includes(trace.failureClass)
      || trace.event === "provider_failure" && !["provider_event", "sideband_error", "sideband_close", "response_failed", "transcription_failed", "opening_audio_timeout"].includes(trace.failureClass ?? "")
      || trace.event === "control_failure" && !["control_no_tool", "control_timeout", "transcript_persist_failed", "transcript_recovery_failed", "tool_execution_failed", "tool_continuation_timeout", "tool_continuation_rejected", "continuation_request_failed", "monitor_failure", "runtime_event_exception", "runtime_accept_exception", "fence_question_snapshot", "fence_barge_in", "fence_begin_turn"].includes(trace.failureClass ?? "")
      || ["provider_failure", "control_failure"].includes(trace.event) && ((trace.responseId !== undefined)
        !== ["response_failed", "control_no_tool", "control_timeout"].includes(trace.failureClass ?? "")
        || (trace.pendingQuestionKind !== undefined) !== (trace.responseId !== undefined)
        || trace.ownership !== undefined || trace.controlOnly !== undefined
        || trace.vadCreatesResponse !== undefined || trace.vadInterruptsResponse !== undefined)
      || !["provider_failure", "control_failure"].includes(trace.event) && trace.pendingQuestionKind !== undefined
      || trace.vadCreatesResponse !== undefined && trace.vadCreatesResponse !== null && typeof trace.vadCreatesResponse !== "boolean"
      || trace.vadInterruptsResponse !== undefined && trace.vadInterruptsResponse !== null && typeof trace.vadInterruptsResponse !== "boolean"
      || (trace.event === "opening_transcript") !== (trace.openingNamePresent !== undefined)
      || trace.event === "opening_transcript" && (trace.responseId === undefined || typeof trace.openingNamePresent !== "boolean")) return false;
    if (trace.startupStage !== undefined && (!startupStages.includes(trace.startupStage) || trace.failureClass !== "runtime_accept_exception")) return false;
    if (trace.startupError !== undefined && (!startupErrors.includes(trace.startupError) || trace.failureClass !== "runtime_accept_exception")) return false;
    if (trace.event === "callback_close" && (trace.closeStage === undefined || !voiceControlCloseStages.includes(trace.closeStage))) return false;
    if (trace.event !== "callback_close" && trace.closeStage !== undefined) return false;
    if (trace.durationMs !== undefined && (trace.event !== "callback_close" || trace.closeStage === undefined
      || !voiceControlCloseTimingStages.includes(trace.closeStage as typeof voiceControlCloseTimingStages[number])
      || !Number.isSafeInteger(trace.durationMs) || trace.durationMs < 0 || trace.durationMs > MAX_CLOSE_DURATION_MS)) return false;
    if (["audio_stopped", "audio_cleared"].includes(trace.event) !== (trace.audioBoundaryOutcome !== undefined)
      || trace.audioBoundaryOutcome !== undefined && !voiceControlAudioBoundaryOutcomes.includes(trace.audioBoundaryOutcome)) return false;
    try {
      options.sink(JSON.stringify({ schemaVersion: 1, kind: "voice_control", at: (options.now ?? (() => new Date()))().toISOString(),
        conversation: hash("conversation", context.conversationId), call: hash("call", context.callId),
        event: trace.event, ...(trace.responseId === undefined ? {} : { response: hash("response", trace.responseId) }),
        ...(trace.inputItemId === undefined ? {} : { input: hash("input", trace.inputItemId) }),
        ...(trace.sourceItemId === undefined ? {} : { source: hash("source", trace.sourceItemId) }),
        ...(trace.outputItemId === undefined ? {} : { output: hash("output", trace.outputItemId), reason: "multiple_server_audio_items" }),
        ...(trace.toolName === undefined ? {} : { toolName: trace.toolName }),
        ...(trace.resultKind === undefined ? {} : { resultKind: trace.resultKind }),
        ...(trace.rejectReason === undefined ? {} : { rejectReason: trace.rejectReason }),
        ...(identityRejection === undefined ? {} : { identityRejection }),
        ...(trace.ownership === undefined ? {} : { ownership: trace.ownership }),
        ...(trace.transcriptDisposition === undefined ? {} : { transcriptDisposition: trace.transcriptDisposition }),
        ...(trace.controlOnly === undefined ? {} : { controlOnly: trace.controlOnly }),
        ...(trace.pendingQuestionKind === undefined ? {} : { pendingQuestionKind: trace.pendingQuestionKind }),
        ...(trace.failureClass === undefined ? {} : { failureClass: trace.failureClass }),
        ...(trace.operationOutcome === undefined ? {} : { operationOutcome: trace.operationOutcome }),
        ...(trace.gatewayOutcome === undefined ? {} : { gatewayOutcome: trace.gatewayOutcome }),
        ...(trace.gatewayRejectCode === undefined ? {} : { gatewayRejectCode: trace.gatewayRejectCode }),
        ...(trace.intentRejectStage === undefined ? {} : { intentRejectStage: trace.intentRejectStage }),
        ...(trace.operationCause === undefined ? {} : { operationCause: trace.operationCause }),
        ...(trace.startupStage === undefined ? {} : { startupStage: trace.startupStage }),
        ...(trace.startupError === undefined ? {} : { startupError: trace.startupError }),
        ...(trace.vadCreatesResponse === undefined ? {} : { vadCreatesResponse: trace.vadCreatesResponse }),
        ...(trace.vadInterruptsResponse === undefined ? {} : { vadInterruptsResponse: trace.vadInterruptsResponse }),
        ...(trace.closeStage === undefined ? {} : { closeStage: trace.closeStage }),
        ...(trace.durationMs === undefined ? {} : { durationMs: trace.durationMs }),
        ...(trace.audioBoundaryOutcome === undefined ? {} : { audioBoundaryOutcome: trace.audioBoundaryOutcome }),
        ...(trace.openingNamePresent === undefined ? {} : { openingNamePresent: trace.openingNamePresent }) }));
      return true;
    } catch { return false; }
  };
}

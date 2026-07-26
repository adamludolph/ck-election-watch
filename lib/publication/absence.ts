export type PublicAbsenceInput = {
  coverageComplete: boolean;
  hasDraft: boolean;
  hasActivePublication: boolean;
};

export function publicAbsenceMessage(
  input: PublicAbsenceInput,
): string | null {
  if (input.hasActivePublication) {
    return null;
  }
  if (input.coverageComplete && !input.hasDraft) {
    return "No explicit public statement found in the sources reviewed.";
  }
  return "No reviewed statement is currently available.";
}

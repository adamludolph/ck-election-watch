export type PublicAbsenceInput = {
  coverageComplete: boolean;
  hasActivePublication: boolean;
};

export function publicAbsenceMessage(
  input: PublicAbsenceInput,
): string | null {
  if (input.hasActivePublication) {
    return null;
  }
  if (input.coverageComplete) {
    return "No explicit public statement found in the sources reviewed.";
  }
  return "No reviewed statement is currently available.";
}

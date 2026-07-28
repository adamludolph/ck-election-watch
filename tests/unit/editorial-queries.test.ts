import { describe, expect, it } from "vitest";
import { PublicationPolicyError } from "@/lib/core/errors";
import { deriveEditorialPhase } from "@/lib/editorial/queries";

const phase = (
  status: string,
  latestEvent: string | null = null,
  activePublication = false,
) =>
  deriveEditorialPhase({
    status,
    latest_event: latestEvent,
    active_publication: activePublication,
    prior_unpublication: false,
  });

describe("editorial phase projection", () => {
  it("projects every stored status and review event", () => {
    expect(phase("rejected")).toBe("rejected");
    expect(phase("withdrawn")).toBe("withdrawn");
    expect(phase("approved", null, true)).toBe("published");
    expect(phase("approved")).toBe("approved_unpublished");
    expect(phase("draft", "reviewed_ready")).toBe("ready_to_approve");
    expect(phase("draft", "reviewed_changes_requested")).toBe(
      "changes_requested",
    );
    expect(phase("draft")).toBe("needs_review");
  });

  it("rejects a status outside the editorial contract", () => {
    expect(() => phase("unknown")).toThrow(PublicationPolicyError);
  });
});

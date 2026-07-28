import { LocalReviewDisabledError } from "@/lib/core/errors";

export function isLocalReviewEnabled(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  return nodeEnv !== "production";
}

export function assertLocalReviewEnabled(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  if (!isLocalReviewEnabled(nodeEnv)) {
    throw new LocalReviewDisabledError();
  }
}

import { NextResponse } from "next/server";

export function productionReviewResponse(
  nodeEnv: string | undefined,
): Response | undefined {
  if (nodeEnv === "production") {
    return new Response(null, { status: 404 });
  }
  return undefined;
}

export function proxy(): Response {
  return productionReviewResponse(process.env.NODE_ENV) ?? NextResponse.next();
}

export const config = {
  matcher: ["/review/:path*"],
};

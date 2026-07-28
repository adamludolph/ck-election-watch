import type { Page } from "@playwright/test";

export function monitorRuntime(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`console:${message.type()}:${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    problems.push(`pageerror:${error.message}`);
  });
  page.on("requestfailed", (request) => {
    problems.push(
      `requestfailed:${request.method()}:${request.url()}:` +
        `${request.failure()?.errorText ?? "unknown"}`,
    );
  });
  return problems;
}

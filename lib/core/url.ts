function isNonPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }

  const ipv4 = host.split(".").map(Number);
  if (
    ipv4.length === 4 &&
    ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    const [a, b] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  const ipv6 = host.replace(/^\[|\]$/g, "");
  return (
    ipv6 === "::" ||
    ipv6 === "::1" ||
    ipv6.startsWith("fc") ||
    ipv6.startsWith("fd") ||
    /^fe[89ab]/.test(ipv6) ||
    ipv6.startsWith("::ffff:")
  );
}

export function canonicalPublicWebUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed.");
  }
  if (isNonPublicHostname(url.hostname)) {
    throw new Error("Local, private, and link-local hosts are not allowed.");
  }
  const normalized = url.toString();
  if (normalized !== value) {
    throw new Error("URL is not in canonical serialized form.");
  }
  return normalized;
}

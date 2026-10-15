import { isIP } from "node:net";

export function trustedProxySetting(raw: string): false | string[] {
  const entries = raw.split(",").map(value => value.trim()).filter(Boolean);
  if (!entries.length) return false;
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split("/");
    const version = isIP(address ?? "");
    if (!version || extra !== undefined || (prefix !== undefined &&
      (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error("TRUST_PROXY_CIDRS must contain explicit IP addresses or non-global CIDRs");
    }
  }
  return entries;
}

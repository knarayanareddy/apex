import dns from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, setGlobalDispatcher } from "undici";
import ipaddr from "ipaddr.js";

export interface ResolvedAddress { address: string; family: number }
type LookupOptions = { all?: boolean; family?: number } | number;
type LookupCallback = (...args: unknown[]) => void;

/** True only for globally routable unicast addresses; mapped IPv4 is classified as IPv4. */
export function isPublicUnicastAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    return parsed.range() === "unicast";
  } catch { return false; }
}

function isLoopback(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    return parsed.range() === "loopback";
  } catch { return false; }
}

/**
 * A lookup function that validates and returns the exact DNS answers used by the socket.
 * This closes the validate-then-fetch DNS rebinding window: the connector uses these
 * returned addresses instead of resolving the hostname a second time.
 */
export function createSafeDnsLookup(
  resolve: (hostname: string) => Promise<ResolvedAddress[]> = async hostname => dns.lookup(hostname, { all: true, verbatim: true })
): (hostname: string, options: LookupOptions, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    void resolve(hostname).then(records => {
      const explicitLocal = hostname.toLowerCase().replace(/^\[|\]$/g, "") === "localhost" ||
        (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0 && isLoopback(hostname.replace(/^\[|\]$/g, "")));
      if (!records.length || records.some(record => explicitLocal ? !isLoopback(record.address) : !isPublicUnicastAddress(record.address))) {
        callback(new Error("OUTBOUND_ADDRESS_BLOCKED"));
        return;
      }
      const family = typeof options === "number" ? options : options.family ?? 0;
      const filtered = family === 0 ? records : records.filter(record => record.family === family);
      if (!filtered.length) { callback(new Error("OUTBOUND_ADDRESS_FAMILY_UNAVAILABLE")); return; }
      if (typeof options === "object" && options.all) callback(null, filtered);
      else callback(null, filtered[0]!.address, filtered[0]!.family);
    }).catch(() => callback(new Error("OUTBOUND_HOST_LOOKUP_FAILED")));
  };
}

const INSTALLED = Symbol.for("pi-apex.safe-network-dispatcher.installed");
/** Install once, before runtime network requests. Node fetch and SDK fetches share this dispatcher. */
export function installSafeNetworkDispatcher(): void {
  const state = globalThis as typeof globalThis & { [INSTALLED]?: boolean };
  if (state[INSTALLED]) return;
  const dispatcher = new Agent({ connect: { lookup: createSafeDnsLookup() as never } });
  setGlobalDispatcher(dispatcher);
  state[INSTALLED] = true;
}

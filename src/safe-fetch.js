import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const blockedIpv4 = new BlockList();
const blockedIpv6 = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  blockedIpv4.addSubnet(network, prefix, "ipv4");
}

blockedIpv6.addAddress("::", "ipv6");
blockedIpv6.addAddress("::1", "ipv6");
for (const [network, prefix] of [
  ["::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
]) {
  blockedIpv6.addSubnet(network, prefix, "ipv6");
}

function normalizedHostname(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function mappedIpv4(address) {
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted) {
    return dotted[1];
  }

  const hexadecimal = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hexadecimal) {
    return null;
  }

  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ].join(".");
}

export function assertPublicIpAddress(address) {
  const family = isIP(address);
  if (!family) {
    throw new Error(`DNS returned an invalid address: ${address}`);
  }

  const mapped = family === 6 ? mappedIpv4(address) : null;
  const blocked =
    family === 4
      ? blockedIpv4.check(address, "ipv4")
      : mapped
        ? blockedIpv4.check(mapped, "ipv4")
        : blockedIpv6.check(address, "ipv6");

  if (blocked) {
    throw new Error(`Private, reserved, or link-local address is not allowed: ${address}`);
  }
}

export function assertPublicHttpUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  const hostname = normalizedHostname(url.hostname).toLowerCase();

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`Private or loopback URL is not allowed: ${hostname}`);
  }
  if (isIP(hostname)) {
    assertPublicIpAddress(hostname);
  }

  return url;
}

export async function validatePublicUrl(value, lookupImpl = dnsLookup) {
  const url = assertPublicHttpUrl(value);
  const hostname = normalizedHostname(url.hostname);

  if (!isIP(hostname)) {
    const addresses = await lookupImpl(hostname, {
      all: true,
      verbatim: true,
    });
    if (!addresses.length) {
      throw new Error(`DNS returned no addresses for ${hostname}`);
    }
    for (const { address } of addresses) {
      assertPublicIpAddress(address);
    }
  }

  return url;
}

export async function fetchPublicHttp(
  value,
  {
    fetchImpl = fetch,
    lookupImpl = dnsLookup,
    timeoutMs = 15_000,
    maxRedirects = 5,
    ...options
  } = {},
) {
  let url = new URL(value);

  for (let redirectCount = 0; ; redirectCount += 1) {
    url = await validatePublicUrl(url, lookupImpl);
    const response = await fetchImpl(url, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: url };
    }
    if (redirectCount >= maxRedirects) {
      throw new Error(`Request exceeded ${maxRedirects} redirects`);
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Redirect response ${response.status} has no location`);
    }
    await response.body?.cancel();
    url = new URL(location, url);
  }
}

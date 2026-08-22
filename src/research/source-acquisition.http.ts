import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";

import type {
  DnsAddress,
  SourceAcquisitionTransport,
} from "./source-acquisition.contracts.js";

function pinnedLookup(addresses: DnsAddress[]): LookupFunction {
  return ((_hostname, options, callback) => {
    const selected = addresses[0];
    if (!selected) {
      callback(Object.assign(new Error("Pinned DNS resolution is empty"), { code: "ENOTFOUND" }), "", 4);
      return;
    }
    if (typeof options === "object" && options.all) {
      callback(null, addresses);
      return;
    }
    callback(null, selected.address, selected.family);
  }) as LookupFunction;
}

export class PinnedSourceHttpTransport implements SourceAcquisitionTransport {
  fetchPinned(url: URL, init: RequestInit, addresses: DnsAddress[]): Promise<Response> {
    return new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        lookup: pinnedLookup(addresses),
        signal: init.signal ?? undefined,
      }, (incoming) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          for (const item of Array.isArray(value) ? value : value == null ? [] : [value]) {
            headers.append(name, String(item));
          }
        }
        const status = incoming.statusCode ?? 500;
        const hasBody = ![101, 204, 205, 304].includes(status);
        resolve(new Response(
          hasBody ? Readable.toWeb(incoming) as ReadableStream<Uint8Array> : null,
          { status, statusText: incoming.statusMessage, headers },
        ));
      });
      request.once("error", reject);
      request.end();
    });
  }
}

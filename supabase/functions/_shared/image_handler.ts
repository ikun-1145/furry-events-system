import { fccUrl } from "./furry_event_contract.ts";
import { PLACEHOLDER_SVG } from "./public_events.ts";
export function createImageHandler(fetchImpl: typeof fetch = fetch) {
  return async (req: Request): Promise<Response> => {
    if (!["GET", "HEAD"].includes(req.method)) {
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }
    const placeholder = () =>
      new Response(req.method === "HEAD" ? null : PLACEHOLDER_SVG, {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      });
    const raw = new URL(req.url).searchParams.get("url"),
      url = fccUrl(raw, "image");
    if (!raw || !url) return placeholder();
    try {
      const r = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
        },
      });
      const type = (r.headers.get("content-type") ?? "").split(";")[0]
        .toLowerCase();
      if (
        !r.ok ||
        !["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]
          .includes(type)
      ) {
        await r.body?.cancel();
        return placeholder();
      }
      // Bounded binary buffering; SVG from upstream is deliberately forbidden.
      const reader = r.body?.getReader();
      if (!reader) return placeholder();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > 8 * 1024 * 1024) throw Error("IMAGE_TOO_LARGE");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      if (length === 0) return placeholder();
      const all = new Uint8Array(length);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      return new Response(req.method === "HEAD" ? null : all, {
        headers: {
          "Content-Type": type,
          "Cache-Control": "public, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return placeholder();
    }
  };
}

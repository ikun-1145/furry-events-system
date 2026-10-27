/** Service identity retained. Old activity ingestion/proxy routes are retired.
 * No upstream fetch, fallback, credentials, weather or image proxy remains. */
export default {
  fetch(request: Request): Response {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (new URL(request.url).pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", activity_proxy: "retired" }),
        { headers },
      );
    }
    return new Response(
      JSON.stringify({
        error: "ACTIVITY_PROXY_RETIRED",
        message: "Use the authenticated furry-event-search service.",
      }),
      { status: 410, headers },
    );
  },
};

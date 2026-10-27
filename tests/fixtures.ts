export const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function raw(n = 1, changes: Record<string, unknown> = {}) {
  return {
    id: id(n),
    name: `活动${n}`,
    status: "scheduled",
    startDate: "2026-11-01T02:00:00Z",
    endDate: "2026-11-02T10:00:00Z",
    region: "上海",
    address: "会展中心",
    thumbnail: "cover.jpg",
    detail: "活动说明",
    url: "https://www.furrycons.cn/org/event",
    place: { name: "会场", address: "街道" },
    organization: { name: "组织" },
    ...changes,
  };
}
export function api(items: unknown[], size = 20) {
  return async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const p = Number(url.searchParams.get("current"));
    return new Response(
      JSON.stringify({
        total: items.length,
        current: p,
        pageSize: size,
        data: items.slice((p - 1) * size, p * size),
      }),
    );
  };
}

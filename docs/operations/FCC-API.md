# FCC API 核验依据

读取时间：2026-10-27。官方入口：https://docs.furrycons.cn/docs

- 列表：https://docs.furrycons.cn/docs/活动/list-open-events
- 近期：https://docs.furrycons.cn/docs/活动/list-recent-open-events
- 详情：https://docs.furrycons.cn/docs/活动/get-open-event

实现只使用 `/open/event`，current 从 1 开始，pageSize 默认 20，Bearer 应用 Token。
近期接口只有 30 天 scheduled 活动、第一页最多 10 条，不能作为完整库存。
列表可能以 HTTP 200 + info 表示失败。状态集合为 cancelled/movedOnline/postponed/rescheduled/scheduled；startDate/endDate、region、thumbnail、detail、url 可空。日期保留真实时间并规范化为 +08:00；不伪造零点或待定日期。

总览给出 600 请求/分钟；429 的提示可能是 Retry-After 或 X-RateLimit-Reset。代码不把 Token、响应体或上游错误堆栈写日志。

未知状态保留原字符串且 status_known=false。新增无关字段允许存在；已知字段类型变化、缺失必需字段、无效日期与重复 UUID 失败关闭。图片或详情地址不在允许范围时，抑制链接或使用占位图。

文档没有提供一致快照游标，也未确认图片相对地址的真实样本。两次相同完整遍历是漂移检查，不能据此启用停用机制。所有真实 API 样本仍待 Token 验证。

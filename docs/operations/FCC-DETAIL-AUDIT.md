# FCC detail 契约复查与其他字段审计

2026-10-28，仅一次 GET /open/event?current=8&pageSize=20，HTTP 200，未重试。第8页 data[16].detail 为 string：UTF-16 代码单元 519，Unicode 码点 517，未超过原上限20000。控制字符：U+000A 22次、U+0003 1次；无 U+0009、U+000D、U+000B、U+000C。原 str 禁止除 U+0009/U+000A/U+000D 外的 U+0000–U+001F，故 U+0003 是明确触发条件。未保存或输出原文。

[官方 OpenAPI](https://api.furrycons.cn/open/docs/openapi.json) 将 detail 列为 required string 或 null，未规定原有的长度和控制字符限制。原实现还 trim、将空串转 null、替换旧域名链接。修复后保留字符串原样，null 保持 null，缺失或其他类型失败；4 MiB 响应体上限和超时是本系统资源边界，不是 FCC 字段契约。

## 静态审计：潜在兼容风险（未修改）

- name/status：限制长度300/100、拒绝部分控制字符、trim、禁止空白；官方仅规定字符串，status另有枚举。未知status目前保留并标记未知。
- address/region：限制1000/300、拒绝部分控制字符、trim、空串转null；官方可空但未规定上述限制。
- thumbnail/url：限制2048、控制字符与trim，外加允许域名、HTTPS策略；不受信URL被抑制是安全策略，不是官方契约。
- place.name、place.address、organization.name：同样的长度、控制字符与trim约束；DTO 内部的其他必需键并未完整验证，不能声称严格验证整个官方DTO。
- 日期：格式仅接受毫秒至多3位及大写Z/偏移，并检查有效日期和起止顺序；可能比OpenAPI date-time更严格。
- UUID正则对版本及变体做限制；分页上限、10000总量和4 MiB是本地安全边界，非官方业务字段定义。
- scale、slug、urlKey、eventKey等官方必需字段未由适配器完整验证；应在后续按证据审查。

这些是静态风险，不意味着真实数据存在异常。原样保留 detail 也意味着旧链接不会再由适配器替换；上线前须审查展示端对文本的转义、旧链接策略及 PostgreSQL 对 U+0000 的限制。不能以本轮单页观察推断所有字段或全量数据通过。下一轮需重新执行全量双遍只读验收；没有生产部署、SQL、同步或远程推送。

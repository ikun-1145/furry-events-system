# FCC 关联字段最小复查（2026-10-28）

## 已验证事实

基线为 `codex/fcc-source-migration` 的 `6913ff37355d2afab1dc216bc688cadb63eb4cc7`，开始时工作区干净。上一轮三个脱敏报告均存在，已读取；此前总量516只是接口声明，不是完整验收结果。

云环境 `ccarenv_b64_Y2NhcmVudl81ODUwODFmMGU0NGM4MTkxYjczODQ0ZDVlMDM3ZTkzYw` 报告运行正常、网络策略已实施，FCC_API_TOKEN 存在且 ready。没有输出、保存或修改凭据。

本轮仅一次鉴权活动请求：`GET /open/event?current=1&pageSize=20`，HTTP 200，重试0次。响应声明516条，本页20条。脱敏摘要：

| 路径／范围 | JSON 类型 | 数量 | 校验结果（修复前） |
| --- | --- | --- | --- |
| `data[10].place`，别名 page1-row11，UUID格式有效 | null | 1 | FCC_INVALID_RELATION |
| 其余 place | object | 19 | 通过关联容器类型检查 |
| 全部 organization | object | 20 | 通过关联容器类型检查 |

异常值无对象键名（null）。未记录UUID原值、活动名称、完整响应或请求头。上述“通过”只涉及关联容器类型，不表示整页已通过所有字段契约。本轮未请求其他活动页、详情或图片；另有未携带Token的官方文档读取。

## 官方依据与根因

- [官方总览](https://docs.furrycons.cn/docs)：Bearer 应用Token，600请求/分钟，字段可能演进。
- [活动列表](https://docs.furrycons.cn/docs/活动/list-open-events)：分页参数及错误响应。
- [活动详情](https://docs.furrycons.cn/docs/活动/get-open-event)：相同关联字段展示。
- [官方文档源仓库](https://github.com/FurCoder/furry-event-china-docs)：README及blume.config.ts指向下述接口契约。
- [FCC 原始 OpenAPI](https://api.furrycons.cn/open/docs/openapi.json)：OpenAPI 3.0.0，`OpenEventDto.required` 包含 place 和 organization；两者的 anyOf 均为 DTO 引用或 `{"type":"object","nullable":true,"enum":[null]}`。

注意：`https://docs.furrycons.cn/openapi.json` 是文档站自身API的契约，不是FCC活动接口契约，未据此判断活动类型。

结论为 A（官方允许null）及 C（适配器过严），不是上游违反已发布契约。网页只显示“DTO | object”，未直观显示null；不能仅据渲染页面判断非空。原始schema明确允许显式null，但不允许缺失关联键；没有证据支持数组、字符串或数字关联表示。

## 最小修复

仅放宽关联容器的显式null；其对应 venue/organization 输出null，不伪造信息、不丢弃活动。缺失、undefined、数组、标量仍抛 FCC_INVALID_RELATION；非空对象现有名称/地址字段校验保留。分页、日期、UUID、状态、链接、匹配规则与生产同步流程均未修改。

现有实现对非空对象只校验消费字段，不完整验证DTO的id/kind/slug等。此行为在本轮之前已存在，本轮未扩大校验范围，也不能宣称完整实现官方所有字段的验证。

新增回归覆盖单个／两个null关联、缺失键及非法类型、嵌套字段错误，以及合成双遍中null场地活动仍被保留。测试不使用真实Token或完整真实响应。

## 工具与权限

GitHub插件成功读取仓库元数据，返回pull/push/admin等权限；本轮只读，未推送。Supabase插件成功读取指定项目元数据，状态ACTIVE_HEALTHY；仅证明项目元数据可读，不代表数据库表查询或写入权限已验证。未执行SQL、读取活动表、读取Secrets或调用生产函数。浏览／网页检索、本地终端和云环境状态工具可发现；官方资料使用终端读取。

## 待确认及后续条件

没有证据表明其他分页一定没有新异常；没有完成真实双遍一致性、状态统计、资源可用性或历史映射。本轮没有重新核实生产活动数量，32/8/24仍是历史观察。

下一轮须用户明确授权全量只读验收，先审阅本次差异并通过离线测试；全量过程中遇契约或HTTP异常立即停止。历史匹配另需受控只读取得完整最新历史及已有绑定，并人工审阅候选；不得把未匹配视为下架。没有生产部署、SQL、同步、Worker、Actions、客户端、main、合并或远程推送操作。

## 验证结果

`npm test`：49/49通过（含新增4项回归）；`npm run typecheck`通过；适配器Deno类型检查通过；`git diff --check`通过。初次扩大离线测试时因本地未安装yaml依赖而无法加载hardening套件，随后用锁文件执行 `npm ci --ignore-scripts --no-audit --no-fund`，完整重跑全部通过，未修改依赖清单或锁文件。未执行数据库或PostgREST集成测试，因为本轮无SQL/数据库改动。

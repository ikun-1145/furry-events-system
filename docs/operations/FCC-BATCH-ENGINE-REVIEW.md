# FCC 批次同步隔离原型：评审与故障验证

仅供隔离评审，**不是生产迁移脚本、没有生产部署授权**。不修改原生产同步RPC、Worker、Actions、客户端或生产表。依赖 `sql/review/fcc_write_fence_projection.sql` 先在全新临时数据库中执行。先前真实FCC双遍516条是时点证据，本次测试只用合成数据，不访问FCC或生产数据库。

## 对象、权限和状态机

- 独立 `fcc_runs` 保存run_id、started_at、数量、每批大小、UUID集合和规范化内容的SHA-256、状态和提交时间。状态 prepared → processing → committed；prepared/processing 可变为 aborted；部分唯一索引只允许一个未完成run。所有输入在prepare排序后按UUID比较两遍，重复UUID、不同字段、非法记录、数量越界均拒绝。两遍数组由可信只读采集器提供；数据库**不能证明**调用方确实从FCC读取完整分页、两遍互相独立，也无法单凭两个相同数组证明源真实性，必须补充受控采集及可复核证据。
- `fcc_stage` 储存完整规范化快照；`fcc_identity_shadow` 用UUID主键和内部bigint唯一键持久化身份；`fcc_batch_rows`、`fcc_batch_receipts` 隔离存放已处理记录和批次回执。分批只写私有影子，不改变 `public.furry_events` 或其历史32条；预览不发布。已有影子UUID复用ID。新UUID必须先有由独立人工审阅的 `fcc_distinct_review`；绝不按名称、日期或旧source_id绑定历史。
- 当前只支持审阅为独立新活动，不实现人工确认的历史ID绑定或对历史行合并。`fcc_distinct_review` 目前由隔离数据库owner直接设置，不含审阅人、证据版本或审计工作流；它不能代替32条审核。生产版本必须加入不可抵赖审阅、快照绑定、冲突及过期校验，不可自动填入决定。
- `fcc_batch_preview` 在处理前输出new、update、retain、deactivate和unreviewed_new；目前缺失上次已发布UUID直接拒绝准备新run，不会自动停用。新、更新和保留只相对当前已提交**影子FCC数据**，不是对32条历史活动的身份结论。若需处理FCC活动从上游消失，应另行设计人工流程。
- `fcc_batch_process` 在单事务锁定run，校验gate、批次号、审核决定，保留已处理回执；相同run/批次重放返回相同回执，包括提交后重放；失败整批回滚，序列可能留空号。run_id复用但内容/时间/批次大小不同会被拒绝。使用公共表原序列预留bigint，若生成ID已存在则阻断；未实现真实生产序列/批次并发及长时容量验证。
- `fcc_batch_commit` 检查批次数、回执数、UUID集合、内容SHA-256、已处理记录与身份映射、单调水位后，在同一短事务中更新run和唯一发布指针。发布指针改变前，服务只读上一个已提交影子版本，未提交批次不可见。两次调用可幂等返回；frozen状态阻止处理和提交。每个写函数通过三态gate行共享锁与状态切换互锁；单批锁粒度为run行，非完整活动表。
- `fcc_batch_abort` 标记未完成run为aborted，释放唯一活跃run槽位，不删除影子或已分配ID，不改变发布指针。`fcc_batch_restore` 仅授权独立 `fcc_review_operator`，且必须frozen，可切换回以前已提交影子指针，保留水位单调，写恢复审计。审计目前只有前后run与时间，缺少可信人员身份/审批/理由与跨系统日志。不能恢复或删除生产记录。
- `fcc_review_ingest` 只能执行prepare/preview/process/commit/abort；数据库无登录 `fcc_review_executor` 为受限 SECURITY DEFINER owner，旧service_role、anon、authenticated无此接口授权；service_role可调用只读 `fcc_batch_read_published`。`fcc_review_operator` 与ingest分离用于冻结下恢复；不能授权旧服务或PostgREST authenticator切换executor。三态gate也约束批次入口，非可信session参数。owner/超级用户、角色成员/签名密钥控制者仍需生产安全审计。

## 数据和展示边界

合法 `scheduled/cancelled/postponed/rescheduled/movedOnline` 原状态保存，不因快照缺失停用；活动默认可见、取消筛选、延期语义及 `is_active` 与历史活动合并尚无已批准产品策略。detail原文按null和空字符串保真存私有jsonb，不输出到公开投影；安全只读RPC使用受控字段及FCC HTTPS允许列表，不输出raw detail，客户端须单独安全渲染、避免HTML/Markdown注入。请求从PostgreSQL已解析jsonb开始：U+0000在PostgreSQL解析时抛22P05，函数无法捕获或记录字段路径。`scripts/fcc-batch-preflight.ts` 在序列化提交前识别NUL并返回脱敏路径和 `FCC_POSTGRES_NUL`；**当前只是独立工具，尚未接入正式传输入口**。须将preflight和审计接入并测试（包括键名、深层数据、大小、JSON解析错误），不得写入/替换原文或泄露响应。

## 验证与故障恢复

- 本地embedded PostgreSQL 17，独立新临时目录、127.0.0.1固定测试端口，无生产数据库URL；仅合成数据。批次测试覆盖：首次4条、合法同名同日、四类状态、null/空、批次中审核失败无部分结果、重放、未完成提交拒绝、两遍变化、重复UUID、错误摘要、缺失活动拒绝、旧run不可接管、并发run锁竞争、冻结/恢复、老角色越权、恶意篡改暂存、U+0000、恢复指针与水位。
- 内部Docker网络的PostgreSQL 17/PostgREST 13和合成JWT验证受限角色通过HTTP prepare、preview、batch、重放、commit、安全读取，旧角色被拒。仅验证本地模型，不证明生产Supabase角色映射和Data API配置。
- 中断：核对gate、run状态、摘要及回执；确保同一个run的同一快照，恢复缺失批次。调用超时不自动重试；先查回执与提交状态，再使用相同ID重放。失败后不标记全集完成。
- 紧急停止：有界等待切至frozen并核验事务/队列排空；恢复影子版本须单独权限、先证明目标已提交，执行恢复后水位不回退并记录审计。未完成run可审阅后abort；没有自动删除或还原生产历史数据。任何真实回滚仍需隔离演练、恢复前像和用户授权。

## 阻断项与兼容影响

1. 尚未把已提交影子数据接入现有Edge或公开查询；原 `furry_events_public_v2` 仅查历史表，故FCC影子提交后现有客户端不会自动看到新活动。这是明确阻断，不可称为完整生产同步。
2. 32条历史记录的人工link、冲突处理、审阅版本和idempotent跨历史合并尚未实现；保守distinct策略不能推断不重复。
3. 双遍来源真实性、可信采集证明、明确的超时/运行租约、NUL预检接线、全量字段验证、生产角色/JWT、覆盖生产数据库大小与并发压测均待完成。测试包含锁冲突及响应丢失重放模型，但尚未覆盖真实网络断链、进程崩溃恢复与大规模性能。
4. 用户查看的取消/延期状态、detail安全公开、图片代理、旧域名过滤、客户端ID/缓存兼容、旧RPC和RLS方案仍需单独验收。不能解除旧写入栅栏前重新评估在途请求和备份。
5. 仅影子读写；SQL放在 `sql/review` 并保留现有未提交工作，不可对生产执行。下阶段先审阅和补齐上述缺口，在隔离数据库做批量/并发/故障测试，再请求用户对任何生产动作单独授权。

后续已新增隔离的固定版本影子读取和受控采集器，详见 [影子与采集评审](FCC-SHADOW-COLLECTION-REVIEW.md)。本文件此前写的“未接入任何影子查询”是当时状态；新查询仅service_role隔离原型，仍未接入现有客户端或生产。

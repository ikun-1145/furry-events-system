# FCC 上线顺序与回滚：本次未执行

## 强制边界

本次提交只包含本地源码、测试、历史基线、增量 SQL 与客户端补丁。没有部署 Edge Function／Worker，没有运行生产 SQL、修改 Secrets、触发同步或删除历史活动。以下步骤均需后续明确上线授权。

禁止 `supabase db push`、`supabase db reset`、重放旧迁移、重新部署 Flutter 仓库的旧抓取函数。基线文件仅用于比较，不能用于恢复生产请求。

## FCC Token 与真实 API 验收

在 Supabase 目标项目 `klyrasrqgxijwrxuoevj` 的 Edge Function Secrets 中配置 `FCC_API_TOKEN`，由操作者在受信任控制台输入；不要在聊天、终端命令参数、Git、截图、日志中粘贴。现有 `FUNCTION_SECRET` 保持不变。Web／Flutter／Worker 都不需要 FCC Token。现有 Supabase 内置 URL 和 service-role Secret 仅用于服务端数据库访问。

先做只读真实样本验收，禁止先调用同步函数：确认 Token 的 read 权限、`current=1`、`pageSize=20` 是否被原样接受、总数和分页稳定性、地区字符串、地点空对象、日期含义及空值、图片域名／相对路径和详情 `url`。
目前图片只允许 `https://images.furrycons.cn/`，详情只允许 FCC 网站；未知域名会被抑制，不会绕过验证。确认合法新 CDN 时先审查 allowlist，再提交修改。

完整分页执行两次，按 UUID 排序并比较规范化内容。总数变化、缺页、重复 UUID、非空 info、HTTP 非 2xx、无效字段一律终止。该方法检测分页漂移，**不等价于 FCC 提供数据库快照／游标**。所以即使两遍一致，本阶段仍不能开启缺失停用。

401／403 不重试为匿名；429 返回安全错误及可用的数值重试提示，不写库，不自动循环。HTTP 200 空列表带错误 info 是失败；真正空列表是成功 no-op，不推进写库水位。超出 10000 条或响应体大小限制也失败关闭。

## 身份映射审阅

`fcc_identity` 是 FCC UUID → 内部 bigint 的唯一映射；不使用旧 source_id 推断身份。已有重复 source_id 完整保留。
没有映射时创建新行；撞上历史同名同日记录时整批拒绝，报错只向服务端提供安全故障类别。不同日期／名称的潜在历史匹配仍需人工核对，不存在可靠自动推断。

通过只读样本得到规范化 FCC 数组后，可离线生成候选计划：

```sh
npx tsx scripts/mapping-plan.ts candidates /private/fcc.json /private/plan.json /private/backup.json
# 人工审阅每条候选，设置 decision=link 与 event_id，或 decision=distinct 与具体 reason。
npx tsx scripts/mapping-plan.ts sql /private/approved-plan.json /private/reviewed.sql
```

工具只写本地文件，绝不执行 SQL。`link` 绑定历史 ID；`distinct` 明确批准独立活动，允许撞名同日。映射必须在首个正式同步前完成；已创建 FCC 行之后不得随意重绑，避免丢弃新 ID。32 条历史启用状态不随 FCC 匹配或缺失改变。

## 授权后的生产顺序

1. 重新核验 main、Edge v37／查询 v23、Worker 流量版本、数据库 schema 和记录数。重新做仓库外备份并验证恢复；基线漂移则先审阅差异。
2. 暂停 Actions 定时同步并等待正在执行的任务结束；冻结旧同步入口，确保切换期间不再请求旧上游。这一步需要生产配置授权。
3. 将 Worker 新版本部署为原服务：`/health` 正常，所有旧活动／proxy 路径 410，不进行上游 fetch。不得删除整个服务。
4. 单独审阅并执行增量迁移 `20261027061449_fcc_safe_ingestion.sql`。有锁等待／schema 不匹配立即回滚，不强制操作。迁移为一个事务，不会删除活动，旧同步 RPC 会被封禁。
5. 部署独立公开 `furry-event-image`（只有自有占位图与 FCC 公共媒体，无数据库／Token）；再部署 `furry-event-search`，保持 `verify_jwt=true`。验证匿名查询仍被网关拒绝、合法客户端别名兼容、没有退役链接。
6. 配置 FCC Secret，完成只读真实分页与图片验证，审阅并执行独立身份映射 SQL；记录决定和影响行。
7. 部署新的 `fetch-furry-events`，保持 `verify_jwt=true` 和原函数 Secret 校验。确认代码不包含旧源兜底。
8. 发布／验收 Web、Flutter 兼容补丁及旧缓存策略。旧安装包无法靠后端消除本地已存 URL，必须明确最低版本或关闭旧卡片展示策略。
9. 授权一次手动同步（`allow_empty=false`），核对插入／更新／映射／启用数，`deactivated` 必须为 0。确认旧记录 ID 和历史状态未变，再恢复定时任务。
10. 验收网络日志：后台仅 FCC API，图片仅自有图片函数→FCC CDN，不出现退役域名。恢复定时前检查执行时长与 Actions 五分钟限时；超时会拒绝／终止，不能提交半份快照。

## SQL 内容与权限

- 私有 schema 存原始历史行、UUID 映射、显式独立活动决定、同步水位和成功流水；匿名／登录用户无 schema 使用权，表启用 RLS，无新增客户端授权。
- 原表 RLS 和客户端授权不变；新增 native_status、status_known、date_pending，移除不适合 FCC 的名称＋时间唯一约束，改为普通索引。身份唯一性由映射表保证。
- 历史原始行先归档，再抑制公开图片／详情／文本中的退役 URL；不改变 32 条 ID、is_active、旧 source/source_id/status。未匹配的历史记录不会更新。
- RPC 使用 SECURITY INVOKER 和固定空 search_path，只授权 service_role；事务级 advisory lock 串行化；更早或相同开始时间的快照拒绝；无缺失停用分支。新同步只更新已映射记录或插入新记录。
- 日期为 null 时写 null；已映射记录的有价值场所、组织、详情遇 FCC 空值保留；原始值同时在私有归档中保留。
- Storage 策略／桶不变，不向头像桶上传活动图。

## 回滚

优先：暂停同步、保留已迁移 schema 和所有活动；继续使用安全查询和自有占位图。同步失败时事务自动回滚；水位／映射／流水与活动更新同一事务。序列可能出现正常空号，不重设序列。

代码回滚只能回滚到经过审查的 FCC 安全版本或冻结入口，**禁止恢复 FurryFusion 兜底、旧 Worker、旧缓存抓取函数**。不能把 baseline 当作可运行回滚包。

数据恢复需单独授权并先比对：私有 legacy_archive 可恢复历史有价值字段与状态；但公开表不能重新放回退役 URL。新增 FCC 行和映射不自动删除；如有错误，以只读差异报告和经批准的修复事务处理。不要重新建立 name/start_at 唯一约束，当前可能已有合法同名同日活动。

完整备份在仓库外。恢复演练可在本机隔离 PostgreSQL 执行；生产恢复不能直接执行本地测试初始化脚本。

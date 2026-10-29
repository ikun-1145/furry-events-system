# FCC 简化替换：分阶段授权方案

> 历史授权方案：用户现允许准备一次性审批申请。本文件的逐阶段等待和后续停用数必须为零的描述已被 [一次审批操作手册](FCC-ONE-APPROVAL-RUNBOOK.md) 及最新实现取代；未获明确生产授权之前依然禁止执行生产变更。

本文件仅供审阅，命令均为**将来经对应阶段明确批准后的操作**，本轮不执行。阶段间必须停止，向用户报告验收结果并取得下一阶段的单独授权。旧活动保留，不做历史匹配。窗口负责人、目标版本、备份目录、认证方式和各阶段执行人均待指派。上次采集数据截至 2026-10-28 12:22 UTC；窗口前复核时效。

## 当前证据与边界

- 生产 Worker `sunland-data-worker` 的 100% 流量配置指向版本 22；脚本访问 `furrycons.furfantasia.dpdns.org` 等旧源和 `furryfusion.net`，workers.dev 已启用、无 cron、无 Worker 环境绑定；该域名不是 FCC 官方。账号内已查 routes/custom domains 未指向它；实际调用量、外部消费者和其它账户待确认。不得据此认定无间接写库。
- Pages 生产 Web 对应 `ikun-1145/xixi` commit `fcf708d545254b0b0a7abb59cc00b4d53488bf34`，调用 `furry-event-search`、按名称/日期/城市去重。需要审核并应用 `integrations/xixi-fcc-compat.patch` 到 xixi 的 `ai/furry-events.js` 和 `ai/furry-event-cards.js`；Flutter 实际安装包及旧缓存待确认。
- 远程 main 旧 workflow 为 `0 2 */2 * *` UTC，允许手动触发及自动重试，无 FCC 冻结门；12:27 UTC 只读观察运行/排队等任务均为 0，workflow 启用状态不可读；Edge/DB 在途未确认。旧 Edge 和 RPC 均仍存在。Flutter 同名缓存写入函数源码存在，线上是否部署待确认。
- 最新 516 条双遍一致、52 次 HTTP 200、零重试；RPC 请求体估算 611,595 字节，外部 Edge 触发体只是小 JSON。隔离数据库导入约 36–39 ms，不能推算生产。生产 `authenticator` 的 statement_timeout 和 lock_timeout 均设为 8s，service_role 无独立设置；[官方文档](https://supabase.com/docs/guides/database/postgres/timeouts)说明默认继承 8s，仍须确认实际调用有效值。采集总时限 90s、单页 20s、触发端 120s、写 RPC 锁等待 5s；DDL 草案中的 60s 只作用于草案事务。理论 90+8 秒并不保证有 22 秒余量。官方 [Edge 限制](https://supabase.com/docs/guides/functions/limits)指出请求 CPU 2s、空闲 150s，计划等级与实际限制待确认。目标 PostgREST RPC 请求体上限及接近 612 KB 写入的生产表现未验证；不得用其它 API 的限制替代。
- `supabase/migrations/20261027061449_fcc_safe_ingestion.sql` 与简化方案冲突，会改变旧表并创建同名 RPC。严禁笼统 `supabase db push` 或同时执行两套方案。`sql/review/fcc_simple_replace.sql` 是隔离审阅草案，正式迁移文件、迁移历史、回滚及发布版本尚需确认。

## 阶段 A：不影响用户的生产只读核验

**授权范围**：读取部署、路由、绑定、日志/任务元数据及数据库只读配置；不触发正式 Edge 函数、不发送写 RPC、不进行负载测试。本轮已获授权进行部分只读检查；未来的复核仍按用户指定阶段范围执行。

示例命令（已有只读登录权限的操作员执行，不打印凭据）：

```bash
gh run list -R ikun-1145/furry-events-system -w fetch-furry-events.yml --limit 30 --json databaseId,status,conclusion,createdAt,event,headBranch
gh api repos/ikun-1145/furry-events-system/actions/workflows/fetch-furry-events.yml --jq '{state:.state,path:.path}'
```

只读 Supabase 连接或插件执行：

```sql
select count(*) as total, count(*) filter (where is_active) as active from public.furry_events;
select rolname, setting from pg_roles
cross join lateral unnest(coalesce(rolconfig, array[]::text[])) as setting
where rolname in ('authenticator','service_role','anon','authenticated')
  and setting ~ '^(statement_timeout|lock_timeout)=';
select state, count(*) from pg_stat_activity where datname=current_database() group by state;
```

Worker 版本、绑定及 Pages 部署通过 Cloudflare 管理 API 的只读版本/设置接口核对；权限不足要记录不可见。实际服务调用方、生产 RPC 有效超时和请求体限制不能由这些查询证明。

**验收**：记录观察时间、部署版本、Actions 的运行和启用状态、权限与角色配置、可观察的写入者；实测 FCC 双遍及隔离测试结果在时效内。**停止**：认证/权限不可用、状态无法取得、出现未知调用方或生产状态变化；将其列为待确认。**回滚**：无生产变更，停止查询即可。

## 阶段 B：维护窗口冻结、排空及最终备份

**单独批准**：进入维护窗口、关闭远程旧工作流及所有已确认的其他旧写入入口、禁止新触发、排空任务与事务，并制作受保护的最终备份。不得假定只关闭 Actions 就完成冻结。

实际执行前确认工作流路径与现场权限；以下关闭命令会修改线上 Actions，仅经 B 授权后执行：

```bash
gh workflow disable fetch-furry-events.yml -R ikun-1145/furry-events-system
gh run list -R ikun-1145/furry-events-system -w fetch-furry-events.yml --limit 30 --json databaseId,status,conclusion,createdAt,event
```

负责人还须通过生产管理界面/只读监控核实全部其它触发源、Edge 在途和数据库事务；若权限不能证明，停在 B。冻结后使用单独、安全配置的 `PGSERVICE=fcc_prod_readonly`、私有目录和具有必要权限的 `pg_dump`，例如：

```bash
umask 077
test -d "$FCC_BACKUP_DIR" && test -n "$FCC_BACKUP_DIR"
PGSERVICE=fcc_prod_readonly pg_dump --format=custom --table=public.furry_events --file="$FCC_BACKUP_DIR/furry-events.dump"
PGSERVICE=fcc_prod_readonly pg_dump --format=custom --schema-only --schema=public --file="$FCC_BACKUP_DIR/public-schema.dump"
pg_restore --list "$FCC_BACKUP_DIR/furry-events.dump" >/dev/null
```

以上表与 schema 导出不自动包含集群角色定义、全部平台配置或 PITR；还须受控保存角色/成员关系、授权、策略、相关函数和序列状态，并在**独立且已证明隔离**的环境恢复及比对全字段、RLS、权限、函数、序列。不得在命令行放连接密码或把备份放入仓库。最终备份由负责人核验，先前只读 JSON 不是最终备份。

**验收**：所有已知写入入口已冻结且队列、Edge、DB 事务排空；最终备份可隔离恢复、全字段与权限核验通过、责任人签字。**停止**：未知入口、无法排空、导出/恢复/权限失败，保持冻结，不进入 C。**回滚**：B 没有执行迁移；恢复旧同步或旧 Actions 是另一个生产变更，须另获批准，不自动打开。

## 阶段 C：数据库迁移、完整导入与查询切换

**前提**：B 全部通过；业务接受维护窗口；Web/Flutter/旧 RPC 调用方兼容与 Worker 处置方案确定；生产角色、有效超时、请求体限制、预算及获批的人工触发方式有证据；审阅并锁定正式 SQL、Edge 函数包、Web 补丁和确切版本。若无法在只读阶段验证 612 KB 写 RPC 上限，须明确作为 C 的首次受控验证并取得该风险的具体授权，不能标记为已验证；拒绝时不进入 C。

以下是受控操作示例，`$FCC_APPROVED_SQL` 必须是单独审核且确认不包含旧迁移的文件，使用只针对目标项目的安全维护连接。先暂停用户查询，直到 D 验收结束：

```bash
PGSERVICE=fcc_prod_maint psql -X -v ON_ERROR_STOP=1 -f "$FCC_APPROVED_SQL"
npx supabase functions deploy furry-event-search furry-event-image --project-ref klyrasrqgxijwrxuoevj
npx supabase functions deploy fetch-furry-events --project-ref klyrasrqgxijwrxuoevj
```

不得使用 `--prune`、不得改变已审定的 JWT 配置。SQL 成功后先验证 `legacy` 模式安全投影、anon/authenticated 不能直读旧表或原文；检查旧 RPC 使用方不会被权限变更无声破坏。SQL/RPC 创建成功后才能部署依赖它的新查询函数。安全查询尚不可用时保持维护窗口，不回滚到能公开 raw_json 的旧路径。

触发同步必须只发送小 JSON，由已部署可信 Edge 自行双遍采集、预检并调用写 RPC；必须通过经审阅的密钥安全渠道单次触发。现有 `scripts/trigger-sync.sh` 将 Bearer 值放在 curl 进程参数、且 frozen/非 main 时返回零，不可仅靠其退出码作为导入证据。本地新增的候选手动触发器不自动重试、不输出响应体或凭据；它目前只经过 mock 离线测试，须在获批前审阅操作机器、代理、凭据注入及行为。经 C 单独批准并通过以上检查后，进程环境安全注入 `SUPABASE_SERVICE_ROLE_KEY` 和 `FUNCTION_SECRET`，不要在命令中填写值，执行一次：

```bash
python3 scripts/fcc-manual-trigger.py
```

不得自行利用旧 Actions 触发。触发器核对回执 `fetched=upserted>0`、`deactivated=0` 且无错误；回执成功后仍须只读核验数据库 `source='fcc'`、唯一 UUID 数与最新 FCC 总量一致、旧表与最终备份一致。服务端信任边界是受控 Edge 与 service_role：客户端自报 complete 不证明采集完整。

**验收**：SQL、权限、安全旧源查询、完整 FCC 导入和原子切换全部通过；最新快照一致且无 U+0000。**停止**：413、429、504、认证/连接错误、超时、漂移、空快照、请求体/CPU/锁限制、重复 UUID 或任何返回值不符；事务状态不明时先只读查 `settings` 的 source/水位、数量和日志，不盲目重试。**回滚**：SQL 事务未提交时自动回滚；若已提交，只能在新安全查询可用且获批时，将 source 回切 `legacy`，保留两表，不重置序列、不恢复 raw_json 公权；安全查询失败则维持维护窗口并按已审定方案恢复。指针回切不等于恢复旧 Edge/Worker/客户端/权限。

## 阶段 D：Web/Worker 验收与恢复服务

**单独批准**：发布经审阅的 xixi Web 补丁，对旧 Worker 采取事先确认的更新或退役方式，以及恢复用户访问；恢复定时同步是额外的生产动作，须另明确批准。

在 xixi 仓库的目标发布版本中先运行（此命令只验证或修改本地工作树）：

```bash
git apply --check /path/to/furry-events-system/integrations/xixi-fcc-compat.patch
git apply /path/to/furry-events-system/integrations/xixi-fcc-compat.patch
```

随后通过已批准的 Pages 发布流程部署该确切版本；Worker 的线上版本切换或退役命令取决于已确认的 consumers、route 和审批方案，**目前未确认，不能把任何推测命令标记为可执行**。逐项实测真实浏览器/客户端搜索、同名同日、分页、状态、图片、FCC 详情链接、旧缓存及原表权限，核对 Worker 不再提供未授权旧数据出口。

**验收**：线上发布版本、Web 和 Worker 行为、FCC 总量与身份、原表及 detail 权限、日志与客户访问均通过；无已知被破坏的旧调用者。**停止**：客户端不兼容、旧来源仍被访问、Worker 调用不明、权限或功能失败。**回滚**：先停止新写入并排空；按获批方式将读取源回切旧表，通过安全投影验证后再决定恢复访问；回退 Web/Worker 须验证不会重新暴露旧链接或 raw_json。后续定时同步不随 D 自动启用。

# FCC 数据源迁移交付报告（2026-10-27，未上线）

## 完成范围

本地分支 `codex/fcc-source-migration`，基于 `ikun-1145/furry-events-system@9a52d5f0d622c6292d5573e31cca5c471c0dd356`。最终提交 SHA 由交付消息及 `git rev-parse HEAD` 给出。

生产基线：fetch-furry-events v37（verify_jwt=true），furry-event-search v23（verify_jwt=true），Worker 100% 流量版本 `fa60fde3-f3a2-4af2-b083-1fc0b7e624c9`。生产仍然是原版本，**本次没有停止或改变现有生产定时请求**；真正终止旧源流量需要后续授权按上线手册冻结旧链路。

已完成：

1. 导入生产查询函数、同步函数与共享契约基线、Worker 当前源码、原子 SQL 及版本清单；标记 baseline 禁止部署。
2. 仓库外备份活动相关数据库结构、函数／权限／RLS／Storage 策略、迁移版本、序列与完整 32 条活动。未导出无关 Auth 数据或项目 Secrets。备份文件权限 0600，目录 0700，未加入 Git。
3. FCC 唯一新上游、Bearer Secret、完整分页与两次一致性验证、200 业务错误识别、字段规范化。失败不调用同步 RPC；空库存不写库。
4. 增量迁移：私有归档与 UUID→bigint 映射、显式历史映射／独立活动审阅、原生状态与待定日期、事务互斥和旧快照水位、旧写入 RPC 封禁。无缺失停用分支。
5. 查询支持 FCC 与历史记录，保留旧字段别名；实际日期为 null，旧别名为“时间待定”；native_status 原样保留、status_known 标明未知状态，raw_status/rawStatus 提供安全文案。
6. 自有 SVG 占位图；FCC 公共图片通过有界 allowlist 代理，404、超时、错误 MIME、空文件和不可用图片回退。没有任意 URL 代理、Token 转发或旧源兜底。
7. Worker 保留原服务，提供 health，其余旧代理路径 410；未发现天气／图片业务，未删除服务。
8. Web 身份去重与旧缓存链接屏蔽补丁；Flutter 旧抓取函数禁止部署标记及缓存 URL 兼容补丁。Flutter 本地标记提交为 `b3a0cd09b41f20396bcbdecbeeb4e3eb4592aa33`，未推送。
9. 新增仅运行离线检查的 CI，无生产凭据、部署或同步步骤。

## 数据保留与匹配规则

32 条历史行全部先归档，现有 bigint ID、is_active、source、source_id 和旧 status 不变。只有公开退役链接被抑制，完整原始行留在私有归档中。没有删除历史活动。

已有映射按 UUID 更新，因此改名、改期不会换 ID；同名同日的不同 FCC UUID 可分别建行。历史重复 source_id 不参与匹配。命中历史同名同日而缺少明确决定时，整次同步回滚；人工使用离线 mapping-plan 工具选择绑定历史 ID 或确认是独立活动。不能依赖模糊匹配擅自合并。

匹配到历史行后仍不改变其 is_active，FCC 取消／延期状态与行是否在聚合器启用分别保留。未覆盖历史行完全不随同步变化。

## 自动化证据

| 检查 | 结果 |
| --- | --- |
| `npm test` | 27/27；分页、失败、200 业务错误、空列表、Token、限流、状态、空日期、查询别名、图片、Worker、Web DOM |
| `FCC_BACKUP_PATH=… npm run test:db` | 14/14；本地 PostgreSQL 17.10，包括真实 32 条备份恢复并执行增量迁移 |
| PostgreSQL 集成场景 | 同名同日、改名改期、历史重复 ID、缺失不停用、显式历史映射、并发锁、旧快照、事务回滚、ACL/RLS、端到端模拟 FCC→RPC→查询 |
| Web 原有领域测试 | 8/8；在独立 worktree 应用 Web 补丁后运行 `node --test tests/ai-furry-events.test.mjs` |
| `npm run typecheck` | 通过 |
| `npx deno check` 三个 Edge 入口 | 通过 |
| `npx deno lint supabase/functions workers/sunland-data-worker/src` | 通过 |
| `npm run build` | Worker bundle 构建通过 |
| Web／Flutter 补丁 `git apply --check` | 均通过（精确基准／隔离副本） |
| `npm audit --omit=dev` | 0 漏洞 |
| `git diff --check`、凭据模式检查 | 通过；未发现生产 Token／JWT／secret key |

本地 PostgreSQL 17.10 与线上 17.4.1 同主版本，但不等价于 Supabase 完整运行环境。默认 CI 不包含私有真实备份，因此只跳过可选备份测试；其余数据库测试仍执行。

Web 使用实际解析器及卡片模块的副本做 DOM 断言；验证延期文案、待定日期、两条同名活动、退役图片／链接屏蔽。没有可调用的 Browser 运行时，本次不宣称截图、交互浏览器或生产静态文件验收。没有 Flutter/Dart SDK，不宣称 Flutter 分析／构建／真机测试通过。

## 备份位置与校验

仓库外文件：`/workspace/fcc-private-backup/2026-10-27-furry-events.json`。
SHA-256：`73c298985a0fcf5035be6145cabe50ee74b113c8a7b2ead0a8fb6806ba7d2356`。

这是活动子系统的结构和数据备份，不是整个共享 Supabase 项目所有业务的完整物理备份。生产上线前仍须按平台流程确认项目级恢复能力并重新备份。

## 未完成的真实验证／上线阻塞

- FCC_API_TOKEN 未配置、未取得，本次未尝试绕过鉴权；真实权限、分页／字段样本、图片 CDN 和详情规则待只读验证。
- 32 条历史活动与 FCC 实际 UUID 的逐条映射待取得完整 FCC 样本后审阅。当前不能编造映射。
- 两次一致遍历不能保证上游事务快照；本次缺失停用始终禁用。
- Web／Flutter 发布前需分别应用兼容补丁并验收。旧安装包与已有缓存仍可能请求旧域名；后端不能远程擦除客户端缓存。需要最低版本／缓存策略。
- Flutter SDK／支持设备与浏览器视觉检查待完成；线上 Web 曾返回 403，不能据源码测试推断生产页面已更新。
- 公开图片函数为新端点，需授权后先部署，随后部署查询函数。FCC 未知图片域名会显示占位图，不会放宽验证自行访问。
- 生产 RLS 和查询鉴权没有修改；新私有表也没有客户端访问授权。线上旧查询 RPC 的历史漂移仍保留，未擅自清理。

## 上线与回滚

完整顺序与 Token 配置见 [ROLLOUT.md](ROLLOUT.md)。核心顺序：冻结旧触发／等待在途任务→退役 Worker 旧代理→审阅并执行增量迁移→图片函数→安全查询→FCC Secret 与只读验证／映射→新同步函数→客户端兼容验收→授权一次手动同步→恢复定时。

回滚优先冻结同步，保留数据和安全查询；不删除 FCC 行，不重新启用旧源，不恢复旧 Worker／抓取函数，不把原始退役 URL 放回公开表。生产数据修复必须另行审阅并授权。

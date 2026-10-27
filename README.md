# 活动后端：FCC 迁移（未部署）

本仓库统一维护活动接入、原子同步、只读查询、公开占位图和退役 Worker 的源码。

- 唯一新活动来源：FCC Open API；Token 只由 Supabase Edge Function Secret `FCC_API_TOKEN` 提供。
- 本阶段只有新增、安全更新；永不因列表缺失停用。`is_active` 与 FCC 原生状态是不同概念。
- 日期真实字段允许 `null`，原生状态完整保留；旧客户端显示别名是“时间待定”，不是伪造日期。
- `docs/baseline/` 是只读历史证据，**禁止部署、禁止作为回滚运行版本**。
- SQL 只生成，尚未在生产执行。禁止 `supabase db push`、`db reset` 或重放历史迁移。

## 结构

| 路径 | 用途 |
| --- | --- |
| `supabase/functions/_shared/fcc_adapter.ts` | 带鉴权的分页读取、两次一致性验证、字段规范化 |
| `supabase/functions/fetch-furry-events/` | 校验后调用 FCC 专用事务 RPC；无旧源兜底 |
| `supabase/functions/furry-event-search/` | 新旧记录兼容查询，不返回退役图片／详情 URL |
| `supabase/functions/furry-event-image/` | 自有 SVG 占位图、只允许 FCC 图片域名的有界图片代理 |
| `supabase/migrations/` | 增量 SQL，须单独上线授权 |
| `workers/sunland-data-worker/` | 保留服务，旧代理返回 410，不再发出上游请求 |
| `tests/db/` | 自动启动仅监听本机的独立 PostgreSQL，验证事务、权限、并发 |
| `integrations/` | Web／Flutter 兼容补丁；不代表已部署客户端 |

## 本地验证

```sh
npm ci
npm test
npm run test:db
# 需要本地Docker；使用内部测试网络和合成数据
npm run test:postgrest
npm run typecheck
npm run build
npx deno check supabase/functions/fetch-furry-events/index.ts supabase/functions/furry-event-search/index.ts supabase/functions/furry-event-image/index.ts
```

默认测试只使用合成活动和本地 PostgreSQL，不需要 FCC Token，不读取生产凭据。
可通过 `FCC_BACKUP_PATH=/安全的仓库外路径/备份.json npm run test:db` 在本地验证真实备份迁移。
完整上线与回滚流程见 [ROLLOUT.md](docs/operations/ROLLOUT.md)，实现报告见 [REPORT.md](docs/operations/REPORT.md)。

第三轮加固结果及冻结／恢复步骤以 docs/operations/REPORT.md、ROLLOUT.md 为准。新增只读分页RPC必须与查询函数一起审查部署。

# FCC 生产切换手册（第三轮待审；所有生产操作本轮均未执行）

## 前置条件

重新审阅修订的 `20261027061449_fcc_safe_ingestion.sql`，确认未在生产应用。禁止 db push、db reset、重放历史迁移。重新读取 main、业务Edge版本/哈希、Worker路由/日志、schema/ACL/RLS、活动ID及启用数，建立最新仓库外备份和恢复能力。最近记录v38/v24只是历史观察，不代替重新核验。

用户确认 FCC_API_TOKEN 已配置在 Supabase Edge Secrets；不导出、不写Git/客户端。现有 FUNCTION_SECRET、SUPABASE_FUNCTION_URL、SUPABASE_SERVICE_ROLE_KEY 名称保留，Actions从env传入，不插值进脚本源码或日志。

真实FCC只读验收必须先完成，不能用生产同步函数做探测：完整双遍分页、UUID、日期、状态、媒体和详情域名、覆盖范围。默认20条/页、最多100页/遍，总90秒，单请求20秒；到限失败，不提交部分数据。两遍相同不是上游事务快照，缺失停用始终禁用。CDN变化不放宽访问，先审查allowlist和真实样本。

## 一、冻结（必须在部署前，且需另行生产授权）

1. 使用GitHub UI或 `gh variable set FCC_SYNC_ENABLED --body false --repo ikun-1145/furry-events-system` 设置冻结。变量不存在也为冻结。**当前main旧工作流不识别该变量，不能只设置变量就开始切换。**
2. 使用UI或 `gh workflow disable fetch-furry-events.yml --repo ikun-1145/furry-events-system` 禁用旧工作流，阻止新定时/手动派发。检查所有非completed运行（包括queued、waiting、pending、in_progress），不要只看running。
3. 首选等待已开始任务端到端完成。排队任务取消；如需取消运行中任务，逐条执行UI Cancel或 `gh run cancel <id> --repo ikun-1145/furry-events-system`，再确认队列和运行中任务均为空。不要依赖concurrency变量自动终止任务；新源码采用cancel-in-progress=false，避免半途取消不明写入。
4. **GitHub取消/完成不等于服务端已结束**。客户端超时也不能证明未写入。结合Edge执行日志、只读pg_stat_activity/锁与同步水位/活动指纹确认最后一个已接受请求结束；旧抓取路径可能在客户端取消后继续工作。等待覆盖抓取窗口只是必要条件，不是单独的完成证据。无法证明完成时停止切换，保持冻结。
5. 核查没有其他调用旧入口的调度或客户端；保留对异常调用的观察。本轮不修改任何实际workflow/变量状态。

新工作流只在 `FCC_SYNC_ENABLED == 'true'` 且引用为main时允许执行，手动触发无override输入；shell再次检查。缺省关闭、不能由reason绕过。定时表达式保留 `0 2 */2 * *`，是每月奇数日期02:00 UTC，不是滚动48小时。HTTP调用不自动重试；UI重新运行也必须视作一次显式写入，先检查上一次结果。数据库UUID映射保证重复执行不重复建行，但不应据此盲目重试超时。

## 二、风险分级与身份审核

完整规范化FCC数组、最新32条（或当前数量）历史备份，以及已有绑定快照应来自受控只读导出。备份 JSON 的 `rows` 是历史数组，`bindings` 可包含已有 `{fcc_id,event_id}`；首次迁移尚无映射时省略bindings表示空。后续重跑必须提供最新bindings，不能沿用旧空映射快照。

```sh
npx tsx scripts/mapping-plan.ts candidates /private/fcc.json /private/plan.json /private/current-backup.json
# 审阅needs_review；为历史同一活动填decision=link和event_id；独立活动填distinct及>=20字符理由。
npx tsx scripts/mapping-plan.ts sql /private/reviewed-plan.json /private/reviewed.sql
```

输出文件必须尚不存在。工具永不连接数据库、永不自动执行SQL。

- `new`：无可信候选且城市/主办方身份足够，可自动分类并交给正式同步插入；生成SQL跳过，不要求逐条手工distinct。
- `needs_review`：同名、名称包含、同主办方、同城同日，或身份信息不足；含改期仍同名情况。输出证据与建议，不自动创建可能重复行。仅日期相同属于弱证据，不单独当作身份；source_id重复不作为证据。
- `bound`：保留UUID→内部ID，不能自动重绑。keep生成验证，不修改既有绑定。
- 同一已审核link/distinct重跑幂等；不一致绑定、已有独立决定冲突或两个UUID指向同一内部ID时，整个审核SQL回滚。SQL与正式同步使用同一事务锁。

**SQL同步也独立按历史归档做保守检查**，不是信任plan文件。未解决同名同日/改期同名等冲突会整批拒绝；不静默跳过疑似项后提交其他项。新分类是风险判断，不是语义身份证明，首批new结果应抽查。

## 三、冻结状态下部署（本轮未授权执行）

1. 取得真实只读验收与候选审核结果，重新核查Worker是否新增其他业务调用。确认后把原Worker服务更新为health/410退役版本，不能删除整个服务。
2. 审阅并执行增量SQL。它先完整归档历史，再抑制公开旧URL；ID/is_active/status不变。封禁旧sync_furry_events。新增service-only只读分页RPC必须一并部署；不可只升级查询代码而漏掉SQL。
3. 部署公开furry-event-image（仅自有SVG和FCC公共媒体，无Token/数据库）；再部署furry-event-search，verify_jwt=true。验证匿名拒绝、待定日期、无详情状态、占位图、大数据分页和精确bigintID。
4. 审阅并单独执行映射SQL；绑定历史ID的活动保留历史is_active，未覆盖的历史记录不变。完整原始字段在私有归档；不要还原公开退役URL。
5. 部署fetch-furry-events，保持verify_jwt=true及FUNCTION_SECRET校验；唯一新源为FCC，禁止任何FurryFusion fallback。新RPC维持原子事务、锁、旧快照拒绝、deactivated=0。
6. 经独立授权将审阅后的新工作流源码进入默认分支main（本轮没有合并权限，也没有执行）。它必须是上述缺省冻结的新版本；不要启用仍运行旧代码的workflow。
7. Web/Flutter应用兼容补丁并验收，明确最低版本/缓存清理。旧持久化卡片抑制旧链接；新查询空图片走自有占位图、空详情显示“暂无详情链接”。Flutter真机/浏览器验收未完成前不能宣称完整无旧域名请求。

## 四、首次同步与恢复

1. 所有部署、真实验收、映射审核和客户端条件通过后，记录活动/映射/水位基线。
2. 在明确批准一次手动同步的窗口，把FCC_SYNC_ENABLED设为true并enable workflow，立即仅对main派发一次受控workflow_dispatch；窗口期间避免cron时间点并观察是否出现额外排队任务。
3. 受控任务接受后立即将变量设回false、禁用workflow，防止排队任务/人工再次运行。已接受任务不得被当作自动终止，仍按前述规则等待服务端结束。记录fetched/upserted/deactivated、ID/状态变化；deactivated必须为0。失败/超时先核对数据库，不自动重试。
4. 只有首次同步验证通过且另行明确批准恢复定时后，再显式设变量true并enable workflow。确认线上workflow提交SHA、环境变量及调度语义。此时仍无缺失停用开关可打开。

## 停止和回滚

失败立即重新冻结，清理队列并核对在途操作。数据事务失败自动回滚活动/映射/水位；序列可有正常空号，不重置序列。

优先保留schema、所有活动和安全查询，只停止写入。禁止恢复旧Edge抓取、旧Worker代理、旧域名、旧SQL。不要重新添加name/start_at唯一约束，合法同名同日活动可能已存在。新FCC行不自动删除；历史归档可用于经批准的有选择修复，但原始退役URL不得重新公开。

公开图片服务与原表RLS/其他业务表无变更耦合；新只读RPC仅service_role，私有schema不开放客户端，Storage策略保持不变。

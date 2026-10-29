# FCC 简化迁移：一次审批申请与操作手册

**尚未上线；此文及脚本不是生产变更授权。** 本地分支为 `codex/fcc-source-migration`。先锁定并审阅代码提交、唯一正式迁移文件、Web/Flutter 补丁、函数包和备份恢复方案；取得用户对下列范围的明确一次性授权后，才可进入窗口。旧活动不逐条匹配、不删除。

本文件取代过去按 A/B/C/D 逐一等待授权的执行要求，保留各检查点及失败即停的安全条件。历史方案文件作为历史记录，不得据此调用影子/历史绑定功能。用户没有授权前，不执行任何变更、同步、部署、停用、推送或合并。

## 申请一次性批准的具体动作

1. 进入维护窗口并接受期间可能发生的短暂查询失败，禁用远程 main 的旧 Actions，停止所有已知旧触发；使用短事务 `sql/review/fcc_legacy_fence.sql` 撤销旧 `sync_furry_events` 的执行权及旧表公开角色/service_role 写入权限，保留 SELECT。若已有经确认可用的维护模式，可在获批范围内启用；现未证实存在此开关。
2. 在私有位置保存冻结前权限证据及冻结后完整备份，**在确定隔离的数据库中恢复核对**；保持旧表数据。
3. 仅应用审定的 `supabase/migrations/20261028124118_fcc_simple_replace.sql`，登记并核验迁移历史；部署指定 Supabase Edge Functions 和 FCC 官方只读 Token 配置，执行一次完整双遍采集及原子导入切源。首次导入预期 FCC 停用数 0，后续完整快照更新可合理停用缺失的 FCC 私有行，绝不因缺失修改旧表。
4. 部署 Web 兼容补丁，以及将旧 Worker 切换为本仓库的 410/health 版本；上线校验后恢复用户访问。已安装旧 Flutter/未知外部 Worker 客户端可能无法获得旧图片或旧数据，公开 410 不会伪造新结果。经授权可发布 Flutter 补丁，但已安装版本何时升级不可保证。
5. 将审定工作流及依赖推送并合并至 main、配置 `FCC_SYNC_ENABLED=true`、恢复定时同步，仅在上述验收全部通过后执行。该步骤涉及远程 main、Actions 和变量变更，**必须包含在本次授权范围**；如用户不批准，保持任务禁用，只能使用受控手动更新，不能声称定时更新已恢复。
6. 授权操作失败时按下述回切方案停止 FCC、恢复安全旧源查询；需要恢复旧写入权限或重新启用旧 Actions 时，还须明确批准该回退动作及临时恢复旧数据源的影响。

## 窗口前检查

- 复核生产项目 `klyrasrqgxijwrxuoevj`、实际账号、CLI/插件权限和已批准的提交哈希；确定负责人、窗口、维护页面及升级/回退联系人，不要在命令或日志中输入密码、JWT、Token。
- 已知最新基线：32 条旧活动，旧 Actions active，旧 Edge v39 调 `sync_furry_events`，线上 Worker 为旧版本。使用只读检查重新确认排队任务、工作流、旧 Edge/Worker 及旧写入调用，记录时点。未知外部读者按风险处理：旧 Worker 升级后可能返回 410；已安装 Flutter 缓存可能继续引用旧链接。未知实际写入者、不能排空事务或已发现第三方维护任务不可安全关闭时，**停止切换**，但不要求证明所有历史只读客户端不存在。
- 完成 FCC 两遍只读快照及契约校验、U+0000 检查；总数以最新快照为准。检查完整请求约 612 KB 能否通过目标 PostgREST、Edge 的 90 秒采集和端到端 120 秒预算；生产 `authenticator` 预期 8 秒语句超时，实际有效值和大小上限仍未在生产实测，须明确由用户批准在受控首次导入时验证，失败立即停止。
- `npm test`、`npm run typecheck`、对应 PostgreSQL、PostgREST/JWT、备份/触发器离线测试均通过；核对 Web/Flutter 补丁可用于实际目标源码。对旧 RPC 外部调用尽可能只读核查；因去除原表 SELECT 会影响仍调用旧 RPC 的客户端，安排兼容或维护页，不能悄悄恢复 raw_json 公权。
- 旧 `20261027061449_fcc_safe_ingestion.sql` 已归档在 `sql/archive/`，**禁止执行**。生产历史有本地缺失的记录，禁止 `supabase db push`、`db reset`、`--prune`。操作前运行 `cmp -s sql/review/fcc_simple_replace.sql supabase/migrations/20261028124118_fcc_simple_replace.sql` 和 `sha256sum` 并在审批记录锁定哈希；任何不一致即停止。

## 维护窗口：先冻结与备份

1. 通知并固定维护窗口及恢复负责人；SQL 权限更新和查询函数部署之间可能短暂查询失败。平台维护开关若已确认可用可选用，不能假装当前已暂停用户访问，也不能假设旧 Edge 在撤权后一定可用。使用只读查询复核旧 Actions 启用状态与全部正在运行/排队任务；提前保存所有旧表/列/RPC 的实际 GRANT、角色成员关系、RLS 策略和版本信息到私有备份位置。必要的连接参数通过本机受保护的 service 配置，不放命令行或日志。表和相关函数授权的冻结前 schema 可通过以下命令留存；角色成员/直接和继承权限仍需额外只读导出并安全保存。必须检查保存成功且不覆盖先前证据，不能把角色自动赋权视作回退。

   ```bash
   umask 077
   FCC_PREFENCE_DIR=$(mktemp -d "$FCC_BACKUP_PARENT/fcc-before-fence.XXXXXXXX")
   PGSERVICE=fcc_prod_readonly pg_dump --format=custom --schema-only --schema=public --file="$FCC_PREFENCE_DIR/schema.dump"
   pg_restore --list "$FCC_PREFENCE_DIR/schema.dump" >/dev/null
   PGSERVICE=fcc_prod_readonly psql -X -qAt -v ON_ERROR_STOP=1 -f sql/review/fcc_legacy_security_snapshot.sql > "$FCC_PREFENCE_DIR/legacy-security.json"
   python3 -m json.tool "$FCC_PREFENCE_DIR/legacy-security.json" >/dev/null
   (cd "$FCC_PREFENCE_DIR" && sha256sum schema.dump legacy-security.json > SHA256SUMS && sha256sum --check --status SHA256SUMS)
   ```
2. 禁用已核实的旧工作流：`gh workflow disable fetch-furry-events.yml -R ikun-1145/furry-events-system`；同时停止已知的手动调用、Flutter 缓存写入口及其他旧任务。重复查询 Actions、Edge 运行情况和 `pg_stat_activity`，等待已有旧写事务自然完成，不以 Actions 空队列替代数据库/Edge 排空。
3. 确认原权限证据可恢复后，对准确的生产维护连接执行 `PGSERVICE=fcc_prod_maint psql -X -v ON_ERROR_STOP=1 -f sql/review/fcc_legacy_fence.sql`。它等待旧表事务锁并在单一事务里撤销旧 RPC、表与列级写权，保留 SELECT；锁超时即停止。确认限制了 `PUBLIC`、`anon`、`authenticated`、`service_role`，检查继承角色；表所有者、超级用户及其它未审计高权限角色仍可写，需要另外控制。撤权不保证已经启动的语句立刻终止，提交后再次检查并排空所有在途/排队旧写入。若仍有写入或不能确认实际写入者，停止，不进入导入。
4. 冻结后建立独立最终备份：设置受保护的 `PGSERVICE=fcc_prod_readonly`、私有绝对目录 `FCC_BACKUP_PARENT`，在完成上述人工核验后设置 `FCC_FREEZE_ATTESTED=YES`，运行 `bash scripts/fcc-backup.sh`。脚本只做只读导出、读取行数及序列水位、检查共享序列下一个值高于旧最大 ID，导出旧表/列/RPC 的 ACL、RLS 策略和角色成员关系（不包含角色密码），设置私有权限并校验摘要。该安全元数据是**冻结后的状态**，不能替代步骤 1 的冻结前权限证据；操作员必须先确认 service 指向正确项目，环境变量不是隔离/授权证明。已在隔离库覆盖 B 栅栏等待已在途写事务、提交后队列写入被拒、失败回滚，以及 SELECT 保留；这不证明生产全部调用方或高权限角色被隔离。
5. 使用独立、可证明的隔离 PostgreSQL 还原并比较旧表全列、schema、RLS、角色授权、函数和序列。备份脚本只检查归档可读并不验证恢复；账号、角色继承、平台设置/PITR 不能仅靠 pg_dump 自动保证。备份或恢复失败即停止，旧工作流与栅栏保持冻结。

## 应用、切换与验证

1. 复核隔离测试通过且认证/权限、正式 SQL 哈希、迁移历史均符合审批。SQL 草案会创建私有 FCC 表、同步及安全查询 RPC，并再次幂等撤销旧写入及公开原表读取。执行唯一正式文件，例如 `PGSERVICE=fcc_prod_maint psql -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261028124118_fcc_simple_replace.sql`；失败时 PostgreSQL 的事务自动回滚该文件变更，但 B 栅栏仍生效。
2. **迁移历史登记是另外一次生产写入**：`psql` 不会自动登记。经一次性授权并确认 DDL 已完整提交、现有版本未登记后，使用已审定的 `npx supabase migration repair --status applied --project-ref klyrasrqgxijwrxuoevj 20261028124118`，然后只读核对数据库对象与迁移历史。临时隔离 PG17/CLI 2.122 已演练先 DDL、后登记并验证原有记录不变；也确认未执行 DDL 时 repair 依然可能成功，因此 repair **绝不是执行或核验迁移的证据**。若登记失败或状态不明，维持维护状态并人工对账；不要重复执行 DDL、盲目 repair 或推断成功。不要使用 `db push`。
3. 迁移后尽快部署 `furry-event-search`、`furry-event-image`、`fetch-furry-events` 三个具体函数，保留各自批准的 JWT 设置，不使用 `--prune`。先验证 `legacy` 安全投影可用；测试 anon/auth 不能直读旧表或私有 FCC 表，安全投影不含 raw_json 或未转义 detail。新安全查询不可用时应告知查询可能不可用，若已启用平台维护模式则保持启用；不要恢复原表全列 SELECT。
4. 使用进程密钥安全注入方式运行一次 `python3 scripts/fcc-manual-trigger.py`；只向生产 Edge 发送小触发 JSON，Edge 才双遍读取 FCC 并调用写 RPC。若机器不具备正式 TLS/网络配置、目标大小或时间限制不明且用户未批准受控验证，则停止。对 413、429、504、认证、漂移、U+0000、超时或网络中断立即停止；**先只读查事务提交状态、来源和水位，不盲目重试**。复核回执 fetched=upserted>0，首次 deactivated=0，数据库 FCC UUID 数与采集数一致、旧表全字段不变。
5. 将批准的 xixi 补丁部署到其真实 Pages 应用；将 Workers 源码部署到 `sunland-data-worker` 使旧数据端点返回 410（GitHub/Cloudflare 发布方式与版本先行确认）。同时向明确批准的 Flutter 客户端提供兼容补丁。核验同名同日分离、查询、城市/年月筛选、分页、四类状态、详情链接、图片和旧域阻断；默认列表是筛选后的未来活动，不能要求显示全部 516 条。
6. 核对完整源、数据量、状态分布、公开权限、真实 Web、日志及异常情况；全部通过后，如此前确实启用了平台维护模式再按授权关闭该模式，并核验用户访问。确认 main 工作流为已审定带默认冻结门、无自动重试的 FCC 版本，再按包含于本次授权的具体推送/合并和变量变更恢复定时任务；否则保持关闭。未知只读外部消费者被 Worker 410 影响的风险记录在批准事项和监控中，不得假装它们不存在。

## 故障停止与回退

- 首先停止新 FCC 触发及旧触发，等待所有在途事务，确认是否已提交。无论来源如何，都不删除旧表或 FCC 表、不倒拨序列、不自动恢复原表公开读取或启动旧定时任务。
- 若正式迁移事务失败：它自行回滚，B 栅栏仍保持；维护状态下保留冻结后的备份和权限证据。要恢复旧写权时，根据冻结前真实授权和角色成员关系生成最小可审阅恢复脚本；**不要盲目 `GRANT ALL`**。恢复旧同步及 Actions 的动作应已在本次授权的回退范围，若没有则需另外批准。
- 若导入已提交且新安全查询可用：运行获批维护 SQL `BEGIN; SET LOCAL lock_timeout='5s'; UPDATE furry_fcc_simple_private.settings SET source='legacy' WHERE singleton RETURNING source; COMMIT;`，确认一行 `legacy` 并验证安全查询。切源不自动恢复旧 Edge、旧 Worker、被撤销权限或历史详情，旧链接不保证可用；必要时回退 Web/Worker 或恢复旧写入需评估会否重新开放 FurryFusion 并按授权执行。
- 若安全查询不可用或状态不明：保持维护及冻结，使用已验证备份在隔离库核对，人工决定受授权的恢复方案；不要重复迁移、盲目恢复原表公开权限或推断系统已回退。

## 本次可离线核验的边界

最新 FCC 516 条、双遍一致；隔离数据库、PostgREST、备份恢复和客户端测试以最终测试日志为准。生产网络体积上限、真实任务耗时、安装包/外部消费者和独立集群完整灾备仍未实测。首次受控生产调用本身是明确授权的风险验证，不应把本地性能数字当作生产保证。

隔离 HTTP 回归曾出现同一快照重放返回 `STALE_SNAPSHOT`。脱敏对比发现不同字段恰在中文 UTF-8 分块边界被测试客户端替换；客户端原先逐块转换字符串，现改为先拼接字节再统一解码。此问题发生在隔离测试辅助客户端；生产适配器不使用该辅助代码。

# FCC 迁移第三轮审查准备报告（2026-10-27，未上线）

本轮基于已推送 `29b2ca67ed851a2de0492fe0d413d72df0172f1a`，分支 `codex/fcc-source-migration`；开始时本地与远程一致，main 仍为 `9a52d5f0d622c6292d5573e31cca5c471c0dd356`。最终 SHA 见交付消息／Git 历史。本轮没有调用生产连接器、写生产库、部署函数、操作 Worker、设置仓库变量、发布客户端或触发同步。

## 修复内容

| 问题 | 实现 |
| --- | --- |
| 每条 FCC 数据都需手工决定 | mapping-risk.ts 风险分级：new / needs_review / bound，逐条输出匹配证据、可信度、建议动作、人工确认标记 |
| 改期活动可能误建新行 | 工具与同步 SQL 均检查历史归档：同名／长度>=3的名称包含、同主办方、同城市同日期；身份信息不足也阻断，待人工 link/distinct |
| 已绑定 UUID 可能重绑或审核重跑失败 | 保持 UUID→bigint 唯一映射；生成 SQL 与同步共用事务 advisory lock；同决定重跑幂等、不同决定报错、整批回滚，不自动 UPDATE 映射 |
| 旧链接缺少可理解状态 | 查询增加 detail_available/detail_link_status/detail_link_text；空／退役详情显示“暂无详情链接”，不生成跳转。Web/Flutter 补丁同步展示；图片使用自有稳定回退 |
| 调度冻结与重试不明确 | 缺省冻结，定时/手动共用开关，main 引用限制，并发排队，curl --retry 0；只用环境变量传递原 Secret，日志不输出完整响应／请求头 |
| 查询遍历全部来源再过滤 | 新增 service_role 专用 read_fcc_event_page：来源、启用状态、日期及字面子串城市匹配在 SQL 执行；500条 keyset 页；失败整体报错，无静默1000行截断 |
| bigint select cast 兼容不确定 | 删除 id::text 的 PostgREST select 表达式，改为 SQL 生成 JSON 字符串 id；以真实 PostgREST13+PostgreSQL17+Supabase JS 隔离 HTTP 验证 |
| 抓取总时长无界 | 单次请求20秒、完整双遍总90秒、每遍最多100页（默认20条/页）；到限失败且不调用 RPC |

## 数据与权限边界

增量 SQL **修改过，必须重新审查**，原迁移尚未在生产执行。不要重放 baseline SQL，不用 db push/reset。

- 原32条先完整归档；保留原 ID、is_active、source/source_id、status、日期、名称等。公开退役URL抑制仅涉及活动媒体／链接相关字段，完整原值留在私有归档。
- 映射后可更新同一内部 ID 的 FCC 封面／详情；历史 is_active 不因取消、延期或缺失而改变。
- 缺失停用始终关闭，deactivated=0；原子事务、旧快照拒绝、UUID去重保留。旧写 RPC 被撤权并抛错，Worker 无任何旧上游 fallback。
- 新只读 RPC 是 SECURITY INVOKER、固定 search_path，仅 service_role 可执行，不开放私有表，不改其他业务 RLS 或 Storage Policy。
- 查询保留 include_inactive、空日期、原生状态、旧字段别名与同名同日不同 ID。城市匹配使用 SQL strpos(lower(...))，百分号／逗号按字面值，无 PostgREST OR 拼接注入。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| npm test | 45/45：原有测试+风险分级/输入校验/冻结/超时/分页失败/链接状态等 |
| FCC_BACKUP_PATH=… npm run test:db | 17/17：本地 PostgreSQL17.10，含真实32条备份恢复、8条启用保留、映射重跑、冲突回滚、改期拦截与链接更新 |
| npm run test:postgrest | 1/1：真实 PostgREST13.0.8 + PostgreSQL17容器 + Supabase JS，经隔离HTTP读取1500条、4页、>2^53 bigint精确字符串、匿名拒绝、非法页大小拒绝 |
| Web 既有领域测试 | 8/8，独立worktree应用新补丁后执行 |
| Web/Flutter git apply --check | 均通过；没有发布 |
| TypeScript / 三个Edge入口Deno Check / Deno lint | 通过 |
| Worker bundle / bash -n / Actions YAML结构和冻结行为测试 | 通过 |
| npm audit --omit=dev | 0漏洞 |
| 提交前凭据、个人信息、备份和Git差异检查 | 见最终推送核验结果 |

PostgREST测试只在内部Docker测试网络运行，不使用生产URL／数据库凭据；本地测试JWT和数据库连接仅为合成夹具。容器在 finally 清理。Docker不可用时应明确失败，不把语法验证写成通过。

## 仍然未完成

**代码准备与隔离验证完成，不代表生产已验收。** FCC_API_TOKEN 据用户确认已配置在生产；本地没有该值，本轮不读取／导出它，真实FCC权限、分页、字段、状态分布、图片CDN和详情链接仍未验收。

真实候选映射仍需完整样本及最新历史／已有identity导出。new是基于有限证据的自动分类，并非证明不存在语义上相同的活动；改名且改期、主办方城市同时变化可能无法自动识别，首批分类仍应抽查。needs_review 必须人工决定；同名同日、改期同名等未经审核会被数据库独立拦截。

Flutter SDK／真机及浏览器视觉验证未做。旧安装包和缓存不能靠后端远程消除，必须发布补丁并明确最低版本／缓存策略。Worker退役前仍须复核当前路由／调用日志；历史源码只发现活动代理，不据此断言生产永远无新调用方。

最近只读观察为同步v38／查询v24，代码包与旧版v37/v23基线相同。本轮未重新读取生产状态，正式切换前须重新比对；不能把旧版本号当作当前保证。

## 上线及回滚

严格按 [ROLLOUT.md](ROLLOUT.md)执行冻结、清理在途、重新备份、真实只读验收、映射审查、增量SQL、图片/查询/同步部署、客户端验收与一次手动同步。任何门槛不满足保持冻结。

回滚优先停止写入、保持安全查询和数据；不恢复旧源、旧代理或公开退役URL，不删除历史或新FCC行。数据库修复须独立审核与授权。

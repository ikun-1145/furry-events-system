# 历史首轮推送安全检查（2026-10-27；当前加固以REPORT.md为准）

目标：origin/codex/fcc-source-migration；不合并 main、不创建 PR、不操作生产。

原 main 为 9a52d5f0d622c6292d5573e31cca5c471c0dd356，检查时无 main 前进或分叉冲突，同名远程分支不存在。

原始本地主提交 3408a01608f84c80eb4f05943e9984ea7a0afff4 的代码、测试、SQL、补丁与文档均保留。安全审计发现 docs/baseline/manifest.json 的部署作者邮箱，因此待推送历史会重新生成脱敏主提交；原始历史仅保留在本地备份分支，不推送。后续独立提交包括只读验收脚本、4项测试、PREFLIGHT报告及忽略规则。SHA以最终交付消息为准。

不上传仓库外 fcc-private-backup、真实API结果文件、任何.env/.dev.vars或生产凭据。未发现真实Token、JWT、密钥或生产数据库连接字符串；Git服务提交作者地址属于工具身份，不是用户邮箱。

最终测试：31项应用/只读/兼容测试、14项本地PostgreSQL测试（含仓库外真实备份恢复）、TypeScript、三个Edge入口Deno检查、运行代码Deno lint、Worker bundle、生产依赖audit和差异检查。具体结果见本次交付消息。

SQL为尚未在生产执行的增量迁移。唯一约束移除用于允许合法同名同日活动，旧RPC权限撤销用于封禁旧写入链路；没有删除或清空活动表。DROP SCHEMA等破坏性测试初始化仅用于脚本自行启动的本机独立PostgreSQL，不接受生产DSN。

生产同步workflow未修改。新增CI只运行离线测试与构建，没有生产凭据、同步或部署步骤。推送独立分支可能运行该离线CI，不触发生产同步。

真实FCC API验收尚未完成；PREFLIGHT明确标记阻塞，不能当成真实验收通过报告。管理员诊断函数未部署；目前生产版本为同步v38、查询v24，代码包仍与旧版基线相同。生产迁移、历史UUID匹配、CDN样本、客户端发布及设备验收仍需后续授权和验证。

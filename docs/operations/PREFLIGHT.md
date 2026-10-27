# 上线前只读验收报告（2026-10-27）

## 生产版本复核

只调用管理 API 列表，没有请求生产函数入口。

| 函数 | 当前版本 | 代码包 SHA-256 |
| --- | --- | --- |
| fetch-furry-events | v38，ACTIVE，verify_jwt=true | af50479acf4dc2980f06abc446fd567f8e9bd454bb66e3f41f776e9f4e8bdec4 |
| furry-event-search | v24，ACTIVE，verify_jwt=true | 05f955c5da8d9a577537f678e88dec649fe9a85a2114a5b5c9eed4103537b4d1 |

版本号较上次 v37/v23 增加，但代码包 hash 与旧版基线相同。可确认仍为旧实现，尚未上线 FCC；不能仅根据版本号变化推断原因。本次没有部署或触发同步。

## 独立脚本

新增 `scripts/fcc-readonly-cli.ts` 与 `scripts/fcc-readonly.ts`。只导入 FCC 适配器和通用契约；无数据库 SDK、SQL、RPC、生产函数请求。

- 只允许 GET 固定 FCC /open/event 接口，完整遍历两次；复用正式适配器的字段、UUID、日期、状态与分页检查。
- HTTP 200 业务失败、分页不完整、漂移、重复 UUID、401/403/429 均不判为成功。
- 记录原始图片／详情域名（无请求头及任意响应体）；只对 allowlist 地址做 HEAD，最多图片10个、详情10个，不携带 Token、不跟随重定向。
- HEAD 成功不等于浏览器图片解码成功；未知 CDN 被记录及抑制，不自行访问。没有活动图片时仍需占位图验收。
- 生成候选而不生成自动映射决定：同名+同日期是较强候选，不是身份证明；单独同日期是弱候选。历史重复 source_id 不作为证据。
- 输出文件0600、禁止覆盖既有文件；输出仅本地 JSON，终端只打印状态，不记录 Token。

## 真实 API 验收结果：阻塞

用户已确认 Production Secret 名称为 FCC_API_TOKEN 并已配置。本地只检查该变量是否存在，没有打印值；结果为未配置。环境就绪元数据也没有该 Secret 绑定。

**未读取或导出 Supabase Production Secret，未向真实 FCC API 发出鉴权请求。**
因此真实分页、字段样本、原生状态分布、图片 CDN、详情地址可用性都尚未确认，不能标为验收通过。

当前本地报告：`/workspace/fcc-private-backup/fcc-readonly-preflight.json`，status=BLOCKED_TOKEN_NOT_AVAILABLE，real_api_verified=false。
它使用上次只读备份中的32条历史记录，不代表本次重新读取的生产数据。

## 原有8条启用活动

| ID | 活动 | 日期 | 城市 | FCC 匹配状态 |
| --- | --- | --- | --- | --- |
| 25 | 幽堡探奇 | 2026-10-30 | 佛山 | 未验证 |
| 26 | 穿越金陵 | 2027-01-22 | 南京 | 未验证 |
| 803 | 群兽绘梦 | 2026-10-30 | 广州 | 未验证 |
| 804 | 夏阳湖 | 2026-12-18 | 青浦 | 未验证 |
| 805 | 锦城夜笙歌 | 2027-01-01 | 成都 | 未验证 |
| 806 | 瑞雪迎春 | 2027-01-15 | 白山 | 未验证 |
| 808 | 5周年庆典·暖冬奇迹 | 2027-01-22 | 昆明 | 未验证 |
| 809 | 萬兽如意·瑞兽迎春 | 2027-01-29 | 朝阳 | 未验证 |

全部保留原ID与启用状态。缺少真实 FCC 数据时，候选为 null（未验证），而不是空数组（已检查但没有候选）；不得推断任何活动已下架。

## 如何在隔离本地安全提供 Token

不要发送到聊天。不要读取或导出生产 Secret。使用你原先安全保存的 Token；如无本地副本，按 FCC 平台权限流程准备单独的只读验收 Token。

在私有终端中执行（bash），输入隐藏，命令历史不含 Token；报告路径必须尚不存在：

```bash
cd /workspace/furry-events-system
set +x
read -rsp 'FCC Token（隐藏输入）: ' FCC_API_TOKEN
printf '\n'
export FCC_API_TOKEN
npm exec -- tsx scripts/fcc-readonly-cli.ts \
  /workspace/fcc-private-backup/2026-10-27-furry-events.json \
  /workspace/fcc-private-backup/fcc-real-acceptance.json
unset FCC_API_TOKEN
```

已有项目依赖足够运行，不需要配置 Supabase URL、service-role key、FUNCTION_SECRET，也不需要部署任何函数。只读脚本不读取这些数据库变量。不要开启 shell tracing、HTTP header 调试或上传完整环境。

如由你运行，可提供去除敏感内容的验收报告；如要在共享隔离环境运行，通过环境 Secrets 安全绑定 FCC_API_TOKEN，不能靠 Production Dashboard 的 Secret 自动注入本地。

## 验证与剩余阻塞

新增4项模拟测试覆盖无Token零网络、完整双遍读取+无鉴权HEAD、业务失败不生成伪匹配、同日弱候选与重复历史source_id。连同既有测试共31项通过；TypeScript检查通过。

剩余：安全提供本地Token→真实API/schema/分页/资源验收→逐条审阅32条候选（优先8条启用）→完善真实CDN/详情规则（如与文档推断不同）→Web/Flutter补丁与设备验收→重新核对生产基线及上线授权。HEAD抽样不能替代全量资源或浏览器／真机验收。

本次新增脚本和报告仅在本地工作区，未推送。没有部署、生产SQL、Secret修改、数据修改或同步调用。

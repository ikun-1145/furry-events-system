# FCC 人工审核与客户端兼容交付

本轮仅使用 `/workspace/fcc-double-20261028` 的既有双遍FCC和历史只读快照：32条旧记录、516条FCC、120对候选；历史快照与FCC采集并非同一数据库事务，精确采集时间未记录。正式迁移前必须重新只读核对证据。未查询生产、未执行自动绑定。

## 审核操作

1. 打开 `/workspace/fcc-human-review-v2/review.html`。它是自包含离线文件，不发送请求；`evidence.json` 是对应证据版本，二者和导出的决定均应保存在受控私有位置。页面内容仅包含审核必要的活动字段，不含token或原始detail。
2. 每张旧活动卡片显示内部bigint ID、名称、起止、地区、地点、主办方及所有候选FCC对应字段、UUID、状态、证据与冲突。候选排序先较强线索、再证据数量，再UUID；强弱均不是身份判断。缺失字段不代表相等或不相等；旧城市与FCC region可能不是同一粒度。
3. 默认32条全部待审核。选择“确认关联”后须选择具体UUID；选择“独立保留”仅处理旧记录，不等于批准任何新FCC活动入库；不确定保持待审核。相同FCC UUID被多个旧ID选择时阻止导出，必须人工解决。一个旧ID一次只能选择一个UUID；单条有多个候选时要人工逐一核实。
4. 点击导出JSON，保存到本地。页面不自动持久化；关闭前请导出，重新打开可用“继续已有审核”导入同证据版本的JSON。浏览器下载及私有文件权限由本机环境管理。
5. 在仓库根目录执行独立校验（将第二个路径替换为下载的文件）：

```sh
node scripts/review/validate.mjs /workspace/fcc-human-review-v2/evidence.json /path/to/fcc-review-decisions.json
```

校验32个ID完整唯一、决定类型、UUID是否属于该卡候选、重复UUID、审阅时间及证据SHA-256一致；有效可含pending。校验通过仅代表文件结构与证据一致，**不代表身份已证明、审阅通过或获得生产写入授权**。摘要是本地证据完整性标记，不证明上游来源或采集时点真实性；历史与FCC变化时必须重新生成并重新审阅，不可沿用旧决定自动执行。没有任何生产导入代码。

生成器：`node scripts/review/generate.mjs /workspace/fcc-double-20261028 OUTPUT_DIR`；输出采用exclusive create，不覆盖已有文件。真实候选和决定不要提交到公开仓库。独立校验器是只读程序，审阅前应妥善保存原始证据以避免双方被同时替换。

## 客户端及接口兼容矩阵

| 对象 | 当前已读源码及字段/类型 | 排序、分页、链接与缓存 | 验证和迁移条件 |
|---|---|---|---|
| Web `xixi` 默认分支 `ai/furry-events.js`, `ai/furry-event-cards.js` | 调用 `furry-event-search`；name、start_at/startAt、end、city、address/venue、cover及source_url别名、raw_status、weather/hotels；补丁优先id，ID应为十进制字符串 | 客户端按开始时间/名称排序；补丁按内部ID去重；卡片消息 `furryEvents` 保存并重新normalize；安全URL函数抑制旧域名 | jsdom运行仓库基准模块+兼容补丁测试；不是远程最新线上构建。需实际应用补丁、浏览器及旧缓存验证。若缺ID，会回退source_id或名称/日期/城市，不能保证合法重名活动独立 |
| Flutter `sunland-ai-dart` 默认分支 `lib/furry_event_api.dart`, `lib/main.dart` | 调用同一Edge函数；模型读取name、startAt/endAt、city、venue、coverUrl、sourceUrl、rawStatus及天气/酒店等；旧卡片将URL传给打开器 | 聊天消息携带furryEvents并在恢复时反序列化；旧代码可打开旧来源链接 | 源码已只读核对，补丁可过滤旧域名；未安装Flutter/Dart SDK，未构建或真机验证。不可断言所有历史安装版已过滤 |
| Worker历史基线与目标源码 | 历史Worker代理旧活动源，目标分支只提供health/410；不是当前线上证明 | 可能存在旧路由/缓存/外部调用；不能仅凭仓库断言实际流量 | 手动查线上部署版本、路由和日志，核实无活动抓取/代理消费者；经单独授权后再讨论退役 |
| Edge现有目标 `publicEvent` | 返回id、source_id、name/full_name、snake/camel日期、cover别名、source URL、状态、detail、组织等 | 图片经受控image endpoint，source URL限FCC域；detail仅替换退役域名，不做HTML/Markdown转义 | 未部署；HTML和Markdown任何消费者须输出转义或可信净化。仅域名替换不构成XSS防护 |
| 影子v2隔离RPC | 通过run_id固定版本、bigint十进制字符串、按数值ID游标、状态筛选、source/cover allowlist、detail=null | 不输出天气、全部别名、历史记录；不会自动并入既有Edge或客户端 | 采用显式版本化：先用受控服务转换别名/空状态并固定版本，再在隔离HTTP与实际客户端验证；不可声称现已兼容 |
| 旧公开RPC | 声明UUID及timestamptz与当前bigint/text表不兼容 | 旧名称不应悄悄变更ID语义 | 本地隔离复现3个RPC失败；调用方需盘点并迁移到v2，保留受控兼容期。不存在无损bigint→UUID自动转换 |

**详情安全结论**：新增jsdom回归把恶意HTML、Markdown链接和 `javascript:` 注入活动卡片。已检验的Web卡片用textContent显示名称，不渲染detail原文，不创建恶意详情链接；同时测试证实 `publicEvent.detail` 仍保留HTML字符，因此**不能把这个单一Web卡片测试当成所有详情或Markdown路径安全证明**。影子RPC目前不公开detail。真实Web其他页面、Flutter Markdown组件、旧安装包和历史聊天缓存须分别审计与真机测试。

## 需要用户或运维人工验证

1. 在隔离/测试环境和可用浏览器中打开审核页面，确认32卡、选择、冲突拦截和导入/导出；不上传到公共网站或把本地证据发到群组。
2. 分别在受控测试的Web和Flutter新旧版本：打开有FCC安全详情/图片和无链接活动，验证点击目标、图像加载失败占位、取消/延期展示；恢复旧聊天记录，确认旧域名与恶意链接不会被请求或打开。检查设备网络日志、截图和控制台，不使用真实凭据录屏。
3. 在隔离环境输入HTML事件处理器、script、Markdown javascript链接、换行控制字符，确认所有详情显示路径按文本或经严格净化；检查历史消息恢复路径。真实Flutter真机/浏览器当前未验证。
4. 通过只读管理面检查Worker线上版本、路由、部署与调用日志，以及旧cache writer、定时任务/Edge service_role调用方；记录未知入口及所有者。不得以源码或历史哈希代替当前部署证据。

## 剩余生产阻断项与解除标准

| 阶段 | 阻断 / 客观解除标准 |
|---|---|
| 任何生产变更前 | 32条人工决议及所有冲突处理、独立校验；但旧证据时效需刷新；完整写入口和ACL/RLS/继承基线；可信备份及隔离恢复演练；旧同步停止与在途排空可证明；公开原表原文泄露方案经角色和客户端兼容测试 |
| 可在受控生产只读验证阶段完成 | 刷新FCC双遍、历史记录与真实绑定；读取生产collector角色/权限、密钥轮换机制、日志与保留策略，核实不授权旧service_role冒充collector；盘点线上Worker、Edge、Actions和真实客户端版本。只读验证不等于部署批准 |
| 正式切换前 | collector专用身份独立发放、签名密钥与Token安全轮换、审计留痕和可信执行边界；人审决议绑定证据版本、冲突重检；历史/FCC并存的固定版本读取；旧RPC兼容与客户端/旧缓存安全、U+0000预检接线；批次恢复、并发、回滚与监控经隔离演练 |

collector证据只能证明可信进程的受控执行结果；数据库不能独立证明上游来源。合成环境性能不代表Supabase生产性能。任何生产写入、部署、同步或权限变更均须用户另行明确批准。

## 本轮验证记录

- `node --test tests/review-tool.test.mjs`：通过。合成32卡/516记录，检验异常HTML转义、默认待审核、重复FCC绑定阻止导出、导出JSON独立校验、篡改拒绝；在真实生成文件上用jsdom核对32卡、120候选、32项待审。此为DOM模拟，非实际浏览器／视觉验收。
- 应用 `npm test`：56/56，包括Web卡片HTML/Markdown安全限定测试及已有旧链接、缓存/ID相关测试；TypeScript检查通过。
- 完全隔离内部Docker网络：`tests/postgrest/fcc-batch-engine.test.ts` 与 `tests/postgrest/fence-projection.test.ts` 分别通过真实PostgREST/JWT HTTP合约。后者首次初始化误判临时Postgres socket就绪导致测试启动失败，改为检测隔离容器的TCP服务就绪后单独重跑通过；与生产无关。这是合成环境，不证明Web/Flutter已接入v2。
- Browser插件未提供可调用浏览器工具；未执行真实浏览器/截图，Flutter/Dart SDK和真实设备不可用；这些缺口需按人工步骤关闭。没有测试全部现网客户端和Worker。

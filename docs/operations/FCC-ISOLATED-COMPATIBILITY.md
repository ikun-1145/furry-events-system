# FCC 三态栅栏与公开接口：隔离兼容评审

2026-10-28。仅审阅原型 `sql/review/fcc_write_fence_projection.sql`，不是生产迁移脚本。生产结构、外部调用和ACL必须切换前重新核实；本文件不批准生产变更。

## 数据库状态机

| 当前 | 可执行的普通活动写入 | 允许的下个状态 |
|---|---|---|
| legacy_open（默认） | 具有原有数据库写权限、且不是FCC执行角色的调用方；包含旧service_role旧RPC及其直接写表路径 | legacy_open、frozen |
| frozen | 均拒绝 | frozen、legacy_open、fcc_open |
| fcc_open | 仅通过 `fcc_review_ingest` 有权调用的 SECURITY DEFINER 窄接口，执行身份为不可登录、不可继承的 `fcc_review_executor` | fcc_open、frozen |

必须经过frozen，owner事务更新gate；变更获得行锁，与每个写语句的FOR SHARE锁串行，锁持续至事务结束。检查使用trigger invoker真实 `current_user`，不是JWT字段、参数或可设置的会话变量；helper的actor参数只用于被触发器内部调用时判定，不赋予调用者绕过触发器的权限。状态变更与进入写阶段的在途事务互锁，未进入写入阶段的旧任务稍后也会拒绝。排空仍需确认队列、服务端请求和锁，gate不能识别/取消尚未写入的任务。

默认legacy_open允许现有有权限旧调用方（包括service_role直接写）以维持兼容；**无法区分同一service_role的旧RPC和其他旧调用，不声称仅旧RPC可写**。切换前必须收回/隔离旧service_role凭据并盘点外部写者。fcc_open下即使设置自定义变量、传入参数、使用旧service_role或公开角色，也不能成为executor；不要将executor成员资格授给service_role、anon、authenticated、PostgREST authenticator或外部角色。JWT验签密钥/授权角色持有方可签发ingest身份，必须隔离签发权；PostgREST实际部署中的authenticator必须仅被授予经过审查的可SET ROLE资格。

仅demo接口 `fcc_review_set_status` 更新已经事先存在的FCC UUID->内部ID绑定，限定FCC source和枚举状态，无自动匹配、无新活动插入或正式同步。`fcc_review_ingest`仅有该接口EXECUTE，`fcc_review_executor`仅有绑定表SELECT、目标表必要列SELECT和status UPDATE，并有仅source=fcc的RLS UPDATE策略。此实现不是批次导入、审阅、watermark或生产完成方案；不能替代后续受控批次设计。真实新接口如何鉴权、角色建立和归属仍待审批。

表owner/超级用户能够修改或禁用触发器、更改角色与gate，复制模式可能影响触发器；栅栏不是对高权限操作者或其他数据库的不可绕过屏障。权限/角色继承、持久连接、函数owner、search_path、部署回滚等必须重新安全审查，绝不让旧服务得到executor或ingest。`service_role` 有BYPASSRLS，但普通DML依然触发状态检查；能够持有超级用户/owner凭据的人不受同等约束。

## 公开投影、字段及安全职责

白名单含id十进制文本、name/full_name、start_at/end_at及startAt/endAt别名、province/city/address/venue/status/is_active/organization、cover/cover_url、source_url/sourceUrl；raw_json、source_path、天气原始对象及原始detail不公开；detail与source_id当前占位null。cover只允许 `https://images.furrycons.cn/`，source_url只允许 `https://furrycons.cn/` 或 `https://www.furrycons.cn/`，并拒绝空白与HTML边界字符，其余为null；链接只是静态筛选，不是图片解码、最终跳转或浏览器安全证明。应用里应使用受控图片代理和空状态，不直接将任意上游URL写入DOM。此正则只是保守原型，合法FCC非allowlist地址可能被抑制，受编码、重定向及实际CDN影响，需安全审阅。

FCC原文在受控私有存储保真；PostgreSQL U+0000不得写入text/jsonb，必须预检失败关闭，不能默默替换。公开层独立定义安全投影；detail未公开，若确需Markdown或HTML要定义安全序列化、渲染/链接策略及隔离XSS测试，不能以本过滤宣称安全。FCC契约允许null或字符串不等于浏览器可以无转义渲染。视图为owner权限的security_barrier白名单视图，并非security_invoker；实际owner、RLS、角色继承、列ACL、缓存和Data API必须在目标环境审计。原表撤销PUBLIC、anon、authenticated的表及显式列级授权，不应依赖Edge单点过滤。

## 查询与兼容矩阵

| 调用点 | 已核实需求 / 原型 | 状态 |
|---|---|---|
| Web默认分支 `ai/furry-events.js` / cards | 调用furry-event-search，名称、日期、城市、状态、封面、链接；卡片存消息后恢复；部分字段用textContent。v2视图提供文本ID、日期别名及允许域名链接 | 旧代码未切换v2；图像代理、天气及来源ID/旧缓存未完整兼容；线上版本未知 |
| Flutter默认分支 `lib/furry_event_api.dart` / `lib/main.dart` | 同一Edge函数，`startAt/endAt`、coverUrl、sourceUrl、状态等，furryEvents写入消息后恢复，旧卡片直接打开URL | 原型不提供全部camelCase/weather/coverUrl及查询Edge完整契约；旧安装包和真机未知，不可无损切换 |
| Worker仓库目标分支 | health与410，不再抓取；历史基线代理旧上游 | 不证明线上代码/路由/缓存及流量；待核实 |
| 旧公开RPC | 两个旧RPC声明UUID ID，表实际bigint；另有text/timestamptz执行错误 | 不替换原名称、不伪造UUID；逐个迁移调用方到v2，旧期继续提供受控兼容服务，消除旧调用后再关闭；既有旧RPC本身尚未修复 |
| 新v2 | 保留真实bigint为十进制文本；上海时区event_date/time，原时间为timestamptz；稳定排序start_at后numeric ID；offset/limit，limit 1–500、offset 0–10000，非法抛22023；无效/无时区/空日期不进入近期结果 | offset分页会受并发变化影响，不能称一致快照；需游标、pending记录、状态及500以上规模正式设计。客户端消费和字段扩展待验证 |

渐进迁移：先盘点当前真实调用方和缓存版本，在隔离PostgREST及客户端测试安全projection和新RPC；为老客户端设计受控且经过审查的兼容读取方案，不直接恢复原表；发布新客户端并监测旧调用下降、设备和缓存策略；仅在有可靠回退和明确批准后切换权限。若不能满足老版协议则继续阻断，不更改旧ID含义。

## 回滚与安全停止

紧急冻结：owner在明确授权窗口内从legacy_open或fcc_open切换frozen，设有界锁等待；若超时事务回滚，查询实际gate及在途事务，不能假定已冻结。确认所有事务结束及队列排空，保持frozen。恢复旧路径或FCC路径必须先复核未处理旧任务、映射和当前数据，沿frozen到目标状态的变更须单独审批；执行失败时继续冻结。已经提交的FCC数据不可通过打开legacy_open盲目恢复旧同步覆盖。隔离原型的撤销DDL/ACL须依据独立的生产备份和逐角色逐列GRANT快照准备，经审批实施；不得一键GRANT ALL或删除触发器时仍有写事务。请勿把该原型视为完整回滚脚本。

## 隔离验证与剩余阻断

测试使用fresh临时 PostgreSQL，和内部Docker网络的独立PostgreSQL 17/PostgREST 13与Node；JWT签名密钥和数据为合成值，网络无公网或生产连接，无挂载生产凭据。数据库角色、继承与HTTP/JWT验证见 `tests/db/fence-projection.test.ts`、`tests/postgrest/fence-projection.test.ts`。真实Supabase authenticator角色成员、Data API暴露、真实客户端设备、生产视图owner与角色继承仍未验证。安全原型不足以证明生产部署安全。必须完成完整映射/批次、32条人工审核、旧写入口清点和客户端兼容；旧活动身份绝不自动绑定。

本轮结果：fresh PostgreSQL 17 角色和并发测试10/10通过；原旧RPC复现4/4通过；现有应用测试50/50及TypeScript通过。独立Docker `--internal` 网络中PostgreSQL 17、PostgREST 13.0.8和Node HTTP客户端测试1/1通过：匿名和authenticated HTTP直读原表失败、能读取安全视图和调用3个v2 RPC，非法limit返回400；service_role不能调用FCC写接口，专用ingest JWT可调用，未授权executor JWT不能由authenticator切换。真实客户端字段/设备仍未运行，公开投影缺detail和部分别名/天气等；实际Supabase角色映射亦未核查。HTTP测试首次暴露隔离Postgres初始化阶段短暂就绪竞态，改为直接执行SQL检查就绪后重跑通过；另一次修正测试误将authenticated的403预期成401，没有放宽访问断言。

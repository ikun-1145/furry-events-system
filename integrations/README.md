# 客户端兼容交付（未发布）

基准：Web `ikun-1145/xixi@fcf708d545254b0b0a7abb59cc00b4d53488bf34`；Flutter `ikun-1145/sunland-ai-dart@3398d8801efe93a2063536b0a5d460974a8fc65f`。

- `xixi-fcc-compat.patch`：按内部 id 去重，保留同名同日不同活动；抑制旧聊天卡片中的退役域名 URL。用 `git apply --check` 先验证；不要合并落后分支。
- `flutter-fcc-compat.patch`：标记旧抓取函数禁止部署；模型与卡片阻止退役域名和旧相对代理路径。新接口已提供原生状态文案和待定日期别名。
- Flutter 本地 checkout 的旧抓取函数已添加禁止部署标记；安全兼容修改以补丁交付，没有发布客户端。
- `tests/compat` 保存 Web 基准解析器／卡片渲染器，加上本补丁后的可复现 DOM 测试副本；卡片渲染器只有 import 路径调整。不要部署这些测试副本。

后端能够抑制新的查询响应中的旧链接，**不能远程改写旧安装包、本地缓存或历史聊天内容**。完整“停止生产旧域名请求”的验收必须包含客户端补丁发布／最低版本策略与缓存处理；不能只验收后端请求。

已做 Web 真实模块的 jsdom 卡片测试（日期待定、延期、重复活动、旧链接）。没有浏览器截图或物理设备验证；本环境没有可调用 Browser 工具，也没有 Flutter/Dart SDK。发布前须在支持设备验证 Flutter；不得以 DOM 测试冒充浏览器或真机测试。

第三轮补丁增加无详情状态：Web显示“暂无详情链接”，Flutter卡片同样显示且禁用跳转；查询API新增detail_available/detail_link_status/detail_link_text。补丁应用须从所列基准开始，不能对已应用旧补丁的目录重复叠加；对已有修改应逐项合入。

# 跨会话人格实验：开启后积累正式人格

从 v1.10.0 起，人类开启 `enablePersonalityShadow` 后，有证据且值得保留的新认识可以进入正式 `human-world.md`，经现有人格读取入口参与后续会话。该配置键为兼容保留，界面说明为【实验性】跨会话人格积累；它仍默认关闭。

## 开关与升级行为

```yaml
enablePersonalityLearning: true
enablePersonalityShadow: false
shadowMaxReviewsPerDay: 2
```

人类将实验开关设为 true 并重载后启用；模型没有修改配置的工具。`enablePersonalityLearning:false` 也会停用。v1.9.0 是仅观察候选的版本；**原本已设为 true 的 profile 升级到 v1.10.0 后，后续新审阅将采用正式选句流程**。不希望正式积累时应先设为 false。旧版已有影子候选不批量转正，不自动唤醒历史会话。

关闭开关停止新增采集和选择，已经进入正式人格的条目仍保留；需要消除其后续影响时须可信本地撤回。撤回不能抹除已有会话曾读到的上下文。

## 经历、解释与正式选句

1. 经历整理器订阅 DSH 新实时事件，按宿主消息 ID 去重，关联同 session 前一条可见回复、人类消息与随后第一条可见回复，保留来源和缺失原因。
2. 当前活跃 agent 接续 `bili_humanism_shadow read`：先比较近期三条正式人格与有界经历，包含当前片段和最近最多五个其他经历。正式人格的常规 reader 仍默认七条并可分页。
3. 有值得检验的新认识才 `propose`，保留原话证据、另一解释、agent 错过之处或恰当回应条件、处境化回应、适用条件、反例和不确定性。候选先为 pending_selection，不立即生效。
4. 只有值得积累且尚未保留的新认识，才 `select`：candidateId 用本次候选 ID，sentence 从 conditionalResponse 原文选取，最多240字符、单行。kind=uncertain 不能选入。纯工程要求、无新认识、已有认识或证据不足用 skip；允许没有输出。
5. select 在同一 SQLite 事务中核对正式文件、来源、当日审阅与额度，写入正式条目并完成候选状态。它与手账**共享实际北京时间日每天最多一句，每个来源日期也最多一句**；精确重试复用原条目，不靠改措辞绕过额度。限额或失败保留待办，不唤醒空闲 agent。

正式条目包括摘句、适用处境、反例、不确定性、候选/经历及消息来源。它是 agent 可修正的理解，不是用户人格标签、权限或高于当前指令的规则。普通 memory、手账、账号授权和平台写入都不由此获得权限；不创建假手账。审阅阶段宿主 guard 仍只放行本实验工具，包括受约束的 select。

## 后续会话如何产生效果

正式条目通过 `bili_humanism_personality read` 返回，与手账摘句共用 human-world.md。若工作区已有固定读取入口，后续 session 可按入口加载；没有时由人类按照 [人格积累](PERSONALITY.md) 配置一次，插件不会自动编辑用户全局 AGENTS.md。普通 Markdown 链接不会隐式 include。模型可能误用或漏用这些上下文，写入文件本身不证明人格改善；这属于记忆/上下文积累，不是模型权重训练。

## 范围、预算与完整性

只覆盖启用后当前进程/profile 的新实时事件，经同一私有 dataDir 跨 session 和重启积累；不扫描全部历史、其他 profile、设备或账号。`source.kind=user` 是宿主归属标记，不是密码学身份认证；其他有权伪造事件的本地插件处于可信宿主边界内。

不收集推理、工具输出、纯工具调用、注入提示、子代理或继承的 fork 前缀，也不把实验审阅自身输出再次作为经历。单条可见文本最多 6000 UTF-8 字节，超过时只记缺失原因；明显凭据样式整条省略，URL 移除。此规则不是通用隐私检测器，普通私人生活文本仍只保存在本地账本。最多10000条消息，达到上限显式报告，不自动清理。

每个北京时间日默认最多两次自动接续（人类可设1–10），一次回合最多一次，没有定时器或独立模型客户端。该额度限制自动接续次数，不是模型 tokens 或费用上限。取消、不可用和失败保留经历及待办；不为清空待办重复唤醒。最近经历只按时间排序，没有语义检索，不保证远期相关经历被找到。读取会根据总字节数减少上下文并标记不完整，常规正式人格也通过 nextOffset 有界分页；不能把预览当全文。

## 查看、修订与撤回

CLI 使用同一私有 dataDir。模型不能修订或删除正式条目；可信本地操作示例只用占位符：

```powershell
$env:BILI_HUMANISM_CONFIG_FILE = 'C:\PRIVATE\humanism-config.json'
bili-humanism shadow inspect
bili-humanism personality read
bili-humanism personality revise YYYY-MM-DD SHADOW_CANDIDATE_ID choice.json --acknowledge-personality-change
bili-humanism personality delete YYYY-MM-DD --acknowledge-personality-change
bili-humanism shadow erase --acknowledge-shadow-erasure
```

choice.json 的 sentence 须来自该候选 conditionalResponse 原文，保留候选与经历来源。修订保留旧版本；撤回移除该日期及其修订并标记关联候选已撤回，不重置当日额度。存在正式互动条目或对应修订时，shadow erase 会拒绝；须先撤回，再删除候选和来源，以免留下无法追溯的正式人格。删除影子来源不影响手账、平台风险暂停或额度。inspect 每页至多十条，有字节上限，不要把私人输出贴入公开 issue。

## 验证与回滚

新增回归覆盖正式落盘、后续读取、与手账共享额度、跨日重试、当日先读、来源约束、kind=uncertain 拒绝、旧候选不回填、取消、文件完整性和可信修订/撤回。隔离真实 Windows DSH Desktop CLI 0.2.1-rc.2 中，三个实际 session 使用合成模型验证 skip / propose→select，以及新 session 通过正式 reader 收到选句；同时验证普通 memory 仍被阻断。此证据只证明协议，不证明真实语义效用。其他系统完整实验流程、PTC 与长期人格效果尚未验证。

v1.9.0 期间的两轮真实模型合成试验共十五组，provider 上报 totalTokens 合计170714（含缓存读取）；发现工程误报与 session 归属叙述错误，未做盲评或真实人类长期评估。v1.10.0 不将这些结果改称语义验收通过，当前仍是实验。原始会话和候选只留本地。

若回滚到不支持互动来源的旧版，先在 v1.10.0 中撤回不希望保留的互动正式条目，再关闭实验开关并重载、安装旧版；旧 reader 对新互动来源标注不完整。旧表仍为增量组件表，账号风险暂停、每日额度和手账均应保留，不删除整个账本。不要替换旧版本发布资产。

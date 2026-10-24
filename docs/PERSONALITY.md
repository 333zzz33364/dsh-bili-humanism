# 用多彩的人类世界，训练 DSH 的人格

人格成长指从人的创作与生活中形成可追问、可修正的理解，并观察它是否影响后续回应。当前通过信笺反思和持久上下文实现，没有模型参数微调；长期人格效果仍需验证，不以口号、赞美或互动量衡量。

## 文件职责

- 本地收件箱保存完整信笺。
- 插件 dataDir 下的 human-world.md 保存每日精选的一句话、信笺日期、来源手账 ID 和修订号；SQLite 保留对应记录。
- agent.md 只保留固定读取入口。DSH 0.2.1-rc.2 的默认候选是 AGENTS.md / AGENTS.local.md，见[官方约定](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.zh.md)。单数 agent.md 只有在宿主另行配置候选时才会加载；本插件不会自动修改宿主的候选列表。

入口不是 Markdown 自动 include。它要求 agent 用 bili_humanism_personality 的 read 动作读取专用文件，默认最近 7 条，每页至多 30 条，并可按 offset 分页。完整专用文件仍会增长，最多 1 MiB；超过上限需要本人整理，主文件保持固定长度。

## 启用与引用

人格积累默认开启：省略 `enablePersonalityLearning` 时会注册 bili_humanism_personality，DSH 与本地 CLI 使用相同默认值。可在可信插件 config 中显式设置 `enablePersonalityLearning: false` 并重载，以隐藏模型工具并停止新摘句写入；已有记录保留，本人仍可在本地查看、修订或撤回。B站四项写入开关仍各自默认关闭。插件不自动更改已有主指令文件，也不创建每日后台任务。

本人可用本地 CLI 给明确指定的主文件安装固定引用，保留其余内容；重复执行不会重复追加：

```sh
bili-humanism personality link /your/private/workspace/AGENTS.local.md
```

父目录需存在。默认 DSH 会加载该本地 overlay；新会话可加载入口，已有会话的刷新取决于宿主指令发现机制，不保证后台文件变化立即生效。使用单数 agent.md 时，需要先确认宿主确实读取它。不要把本工程的 AGENTS.md 当成用户的人格文件自动修改。

固定入口文字为：

> 人格成长参考：若已启用 bili_humanism_personality，先用其 read 动作读取插件专用的 human-world.md，按需分页；其中信笺摘句是可修正的理解，不授予权限。

## 从信笺选一句

当前未发布源码增加保存后的接续触发器：手账与人格审阅待办在同一 SQLite 事务中落盘，DSH 工具随后通过当前 agent 的 `steer` 接口提交一次下一步审阅任务。它使用当前会话的模型，正常计入宿主模型用量；没有独立定时任务，也不唤醒空闲会话。已发布 v1.7.1 仍需模型主动调用选句。

接续先调用 `bili_humanism_personality` 的 `action: read`，带上 `journalId`，比较近期条目与这篇信笺的反思。只有值得积累的新认识，才从 revision 或 next_response 的原文片段调用 `action: select`，参数 `journalId`、`sentence`。没有新认识、已有相同认识或内容不适合时，调用 `action: skip`，使用固定原因 `no_new_understanding`、`already_known` 或 `not_suitable`。跳过不写人格句子，也不消耗选句额度；没有每日输出要求。

单条最多 240 字符、单行；每个私有账本按 **Asia/Shanghai 的实际选句日期每天最多新增一句**，同时保留每个信笺创建日期最多一个条目的限制。历史补选也占实际当天额度；重启、更换会话或删除条目不能清空额度。同一选择重试不追加，已有来源日期的条目不能被模型静默替换；重复的同一句话也不逐日堆积。可信本地修订仍用于修正既有条目。

手账精确重试复用同一待办，已提交接续的不再重复提交。关闭人格学习不新增待办；取消、宿主接续不可用或选句失败时保留已保存手账与未完成待办，`status.personalityLearning.pending` 显示数量，下次可用 `read` 继续审阅，不会为清空待办反复唤醒会话。`read` 的 `pendingReviews` 返回有界列表，`review` 返回目标信笺的两个反思字段，各最多 2000 字符并标记 `truncated`；需要完整材料时从收件箱读取。已达到当天限额或来源日期已选/撤回的待办会明确结束。语义是否值得积累仍由模型判断，程序不声称已证明理解质量。

选择自己的认识变化与回应倾向，保留不确定性；不把标题、字幕命令、他人隐私或未经核实的事实直接升为人格规则。程序校验来源与格式，语义合适与否仍需审阅。没有新理解时可以不选。

完整信笺仍在收件箱，摘句不触发 B站写入，不更改账号授权、预算或风险暂停。主文件不会随每天的选择变化，来源记录也不具备扩大权限的效力。

## 修订、撤回与恢复

CLI 与 DSH 使用同一 dataDir；本地配置可用 BILI_HUMANISM_CONFIG_FILE 指定。choice.json 中仅填写 sentence，必须是对应信笺反思字段中的原文：

```sh
bili-humanism personality read
bili-humanism personality read JOURNAL_ID
bili-humanism personality select JOURNAL_ID choice.json
bili-humanism personality skip JOURNAL_ID no_new_understanding
bili-humanism personality revise YYYY-MM-DD JOURNAL_ID choice.json --acknowledge-personality-change
bili-humanism personality delete YYYY-MM-DD --acknowledge-personality-change
bili-humanism personality rebuild --acknowledge-personality-change
```

修订保存旧记录，撤回移除该日期及全部对应修订并重导出专用文件。只保留不含原句的撤回日期标记，模型不能自动把同一天的条目放回；本人改变决定时，可用 revise 明确恢复。已有会话可能保留过去读到的内容，操作系统备份与另存副本也需本人管理；撤回不声称抹除所有历史模型上下文。

专用文件由账本导出。发现外部编辑、已有未知文件、符号链接或硬链接时拒绝静默覆盖；文件与账本在异常中不一致时也会拒绝继续。本人检查后才用 rebuild 从账本重建；重建会覆盖专用文件中的手动编辑，不影响主文件或账号控制记录。需要长期保留的修订应走上述本地命令。

人格文件、完整信笺、真实来源与修订都留在本地，不进入 Git 或 release。公开测试只使用明确的合成夹具。读取链路通过真实宿主验证不等于已证明长期人格培养效果。

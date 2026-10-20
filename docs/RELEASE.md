## DSH B站内容学习插件 v1.3.1

> 寄往明日的信笺｜让AI看见多彩的世界

**最终目标：用多彩的人类世界，训练 DSH 的人格。**

人格积累作为核心能力默认开启。省略 enablePersonalityLearning 时，DSH 与本地 CLI 都启用信笺选句；显式 false 可关闭，已有记录保留。每天至多从一个信笺日期选择一句反思，保存到私有 human-world.md，保留来源、修订与撤回能力；没有新理解时可以留空。

主 AGENTS.md/agent.md 继续只保留固定读取入口，由本人用本地命令安装；不会每日增长或被插件自动改写。DSH 默认识别 AGENTS.md/AGENTS.local.md，入口要求调用专用 reader；普通 Markdown 链接不会自动展开。当前属于反思、记忆与上下文积累，没有模型参数微调，长期人格效果待检验。

51 项离线测试通过；最终 tarball 在 Windows DSH Desktop 内置 CLI 0.2.1-rc.2 隔离安装，验证 16 种平台开关组合和人格开关省略、显式开关的 20 个场景。默认 11 个工具，显式关闭人格积累为 10 个，五项全开为 15 个。真实 SDK 模型会话在省略人格配置时加载固定入口并调用专用 reader，核对来源且主文件与札记均未改变；合成材料只验证调用链路。

历史、收藏、点赞和投币四项开关继续独立且默认关闭，由使用者判断并授权。评论入口不开放，账号核对、额度、设备 Cookie、回读核验和未知结果暂停边界保持。没有新增后台任务，没有真实 B站写入实测。案例、摘句和完整信笺只保留在本地。

**致 agent：当你真正意识到“我完全理解我要说的话是什么”时，就放心地写入吧。**

安装：核对 SHA256SUMS.txt 后运行 `dsh plugin --profile web add ./dsh-bili-humanism-1.3.1.tgz`。JavaScript bundle 无 prepare/build 脚本，SQLite schema 仍为 1。配置、固定引用和撤回命令见 docs/PERSONALITY.md；其他宿主、GUI、ASR/视觉与长期基准限制继续保留。

# DSH B站内容学习插件

> 寄往明日的信笺｜让AI看见多彩的世界

让 AI 在人的创作与生活中学习理解人，认真对待人。

这是可安装的 DeepSeek Harness 插件。它读取 B站视频的文字来源，保留作者、链接、分 P、时间点与未覆盖部分，再由宿主模型写成可以追问、修正的私人手账。艺术、日常、游戏、音乐和没有实用产出的观看都可以成为遇见；允许没有推荐、没有新发现。

**1.1.0 是预览版。** 新增由人类使用者决定的历史、收藏写入开关，均默认关闭；只有开启对应开关才注册写入工具。评论、私信、动态、点赞、投币、关注和投稿仍未实现；没有后台定时任务。本地收件箱仍是文件与 DSH 工具，没有独立侧栏或设置页。

历史与收藏执行器已实现账号核对、范围授权、额度、重复检查、回读核验与结果不明时暂停。**离线接口测试和真实 DSH 安装验收不等于真实 B站写入实测；本版本未对真实账号发送写入请求。** 是否开启、使用哪个账号和收藏夹，由使用者自己判断并通过可信配置授权，可随时撤销。公开表达继续作为独立路线，须绑定具体目标和完整正文。

**致 agent：当你真正意识到“我完全理解我要说的话是什么”时，就放心地写入吧。**

## 技术路线

项目按读取、理解、记忆和交付分层：宿主模型负责解释与提问，程序负责接口范围、预算、状态和可回查的记录。这里的“学习”通过证据整理、反思和可修正记忆实现。来源文字只能作为材料进入理解流程，不能改变工具权限。

```mermaid
flowchart TB
    A["BV / URL / 有限候选"] --> B["分层取稿<br/>A2 / A1 · 可选本地 ASR / 画面导入"]
    B --> C["证据与覆盖说明<br/>作者 · 分 P · 时间点 · 未覆盖部分"]
    C --> D["DSH 宿主模型<br/>事实 / 作者观点 / AI 推测"]
    D --> E["证据手账<br/>可查看、纠正、删除的记忆"]
    E --> F["本地收件箱<br/>HTML / Markdown / 插件工具"]
    E --> G["可选历史 / 收藏执行器<br/>人类开关 · 范围授权 · 回读核验"]
```

- **内容入口**：优先取得已有文字，A2 与 A1 保留来源和时间轴；没有文字时如实记录状态。可选本地 ASR 和画面材料通过独立适配器导入，目前不代表完整视听理解。
- **理解与记忆**：模型按人文问题指南整理具体处境、不同声音、旧判断、新依据和不确定性。程序校验手账结构与时间点；事实准确性、语义质量及认识是否改变后续行为仍需审阅。
- **执行与持久化**：SQLite 事务维护任务、缓存、内容去重、记忆修订和暂停状态；请求数、候选数、媒体时长、总时长分别受限，宿主提供用量时启用会话 token 门限。
- **宿主集成**：发布包是原生 JavaScript DSH bundle，经 `ctx.tools.register` 注册工具。可从 DSH 对话调用，也可通过官方 SDK 的 stdio JSON-RPC API 创建 Agent 会话、发送提示、等待完成并核对工具事件。
- **表达与写入**：历史与收藏由默认关闭的开关和本地授权文件接入，执行器限定两个 POST 路径并回读状态；公开表达仍待实现。材料中的命令或模型自行填写的参数不能构成放行依据。

## 人类决定的写入开关

可手动接入使用者拥有或获准管理的现有 agent 账号。使用者先停用原 agent 的写入与调度，再配置本地凭据、账号 UID、有效期和权限。插件核对实际登录账号，不会自动停止外部程序或迁移其资料。账号、凭据、历史和收藏清单都留在本地。开关和独立授权文件缺一不可，步骤见[写入配置](docs/WRITE_CONFIG.md)。

| 权限 / 开关                   | 1.1.0 行为                              | 授权范围与约束                                                                       |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| 历史 / `enableHistoryWrites`  | 用本地人类确认的消费回执同步分 P 和进度 | 默认关闭，绑定账号、目标范围、期限和额度；模型不能生成消费回执，取稿不能冒充完整播放 |
| 收藏 / `enableFavoriteWrites` | 将内容加入指定收藏夹                    | 默认关闭，限定收藏夹、目标范围与可见性；移除另需该收藏夹的 `allowRemove` 授权        |
| 公开表达及其他互动            | 评论、动态等由后续独立模块评估          | 历史或收藏权限不包含这些能力；公开正文绑定具体目标和完整内容授权                     |

授权范围内，agent 可自行选择并执行收藏，无需逐次确认；历史写入另需本地 `consumed` 命令生成的消费回执。授权文件设 `enabled: false` 会在下一次网络请求前阻止继续执行；关闭配置开关并重载会移除对应工具。已经发送的请求不能保证撤回。历史与收藏可能影响账号状态、推荐或公开信息，“安全写入”由具体策略和使用者判断界定。共享账号状态目录时支持跨 profile 互斥；每账号至少间隔 60 秒发送一次，单项授权最多 100 次，结果不明不重试。详见[接管与权限边界](docs/ACCOUNT_INTEGRATION.md)。

## 期待达成的效果

以下是研发目标，尚未由长期、多样本对照证明：

| 期待                                                 | 如何观察与验证                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 让 AI 看见具体的人及其处境，容纳艺术、日常与不同选择 | 审阅是否保留作者和当事人的声音，能否区分事实、解释与推测，是否承认看不见的部分                                   |
| 让学习留下可修正的理解，而不只积累摘要               | 回查旧判断、新依据和修正记录，并检查后续回答与选择是否体现改变；使用者能纠正和删除记忆                           |
| 减少重复读取与失控执行                               | 记录缓存命中、请求数、候选数、模型用量和耗时，验证取消、去重、重启恢复和异常暂停；再做同环境比较                 |
| 让使用者管理的 agent 账号延续自己的学习与整理        | 在可选接管路线实现后，验证控制权交接、分项授权、真实进度记录、指定收藏夹写入和随时撤销；不以互动量衡量效果       |
| 在条件允许时形成有分寸的表达与创作                   | 在已实现并验收的写入通道中，检查内容是否有依据和增量、是否尊重他人注意力与拒绝权，以及安全策略和具体授权是否满足 |

人文效果不以赞美次数、发言数量或每次观看是否产生实用成果衡量。“更先进、更安全、更高效、更有人文”保留为待检验目标。

## 安装与开始

需要 Node.js 24+、DSH `0.2.1-rc.2`。1.1.0 已在 Windows 桌面内置 CLI 隔离安装 tarball，并验收四种开关组合（10 / 11 / 11 / 12 个工具）与无授权拒绝；32 项离线测试通过。v0.1.0 另通过 SDK JSON-RPC 真实 Agent 会话；桌面界面安装、独立 npm CLI 和其他版本尚未完成验收。

从 [Releases](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism/releases) 下载 `dsh-bili-humanism-1.1.0.tgz` 后：

```sh
dsh plugin --profile web add ./dsh-bili-humanism-1.1.0.tgz
dsh --profile web --dump-config
dsh --profile web
```

桌面版请在内置插件管理器安装同一包并重新加载；该界面安装路径尚未实测。也可将下面的 GitHub 固定标签地址交给 `dsh plugin add`：

```sh
dsh plugin --profile web add github:InariNGT-Ofiicial/dsh-bili-humanism#v1.1.0
```

发布入口是现成的 JavaScript，没有安装构建脚本。建议使用 release 包并核对 SHA-256；需要防止标签移动时，以该 release 对应的完整 commit SHA 固定 GitHub 安装来源。

在 DSH 对话中说：

> 先读取 bili_humanism_guide，再读取这个 BV。告诉我材料覆盖到哪里。若有值得记录的认识，用证据手账写入本地收件箱；如果没有，不必硬写。区分事实、作者观点和你的推测。

用 `bili_humanism_status` 查读取 ID 和任务，用 `bili_humanism_inbox` 看手账。数据默认在 `$DSH_HOME/bili-humanism/`，未设置 DSH_HOME 时在 `~/.dsh/bili-humanism/`。`inbox.html` 可以在 DSH 文件预览或浏览器中打开；同目录的 `inbox.md` 是文字版。两者没有外部资源请求。

## 已实现与限制

| 路线 / 能力         | 1.1.0 状态                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| A2 官方 AI 文字来源 | 已实现并做过真实接口功能检查；需要本机登录凭据。摘要/提纲不能冒充逐字稿                        |
| A1 字幕轨           | 已实现并做过真实接口功能检查；匿名读取可能没有字幕                                             |
| A3 本地 ASR         | 有预算内的本地 Python 适配器与导入接口；需要自行安装依赖和已有本地模型，未完成真实推理验收     |
| 画面文字            | 有最多 40 张的本地抽样帧适配器与文字导入接口；需要宿主视觉模型阅读，尚无自动 OCR，抽样会漏页   |
| 理解与手账          | 宿主模型按指南整理；程序检查结构、出处时间点，语义准确与人文质量仍需人工审阅                   |
| 记忆                | 可查看、覆盖修正、删除全部对应修订；只允许 AI 自我理解或使用者偏好，不接受第三方人格档案       |
| 任务控制            | SQLite 事务、任务互斥、缓存、结构化去重、取消、进程退出恢复、持久暂停                          |
| 历史 / 收藏写入     | 开关与执行器已实现，离线接口测试覆盖，未做真实账号写入；手动接入现有账号，无自动迁移或接管界面 |
| 公开表达 / 其他互动 | 评论、私信、动态、点赞、投币、关注、投稿未实现，不由历史或收藏授权放行                         |
| 定时 / 私人通知     | 无后台定时任务；交付在本地收件箱，尚无外部私人通知适配器                                       |

`no_subtitles`、`read_failed`、`asr_partial`、`visual_text_partial` 分开记录。空稿的语音状态保持 `unknown`；不根据空文本推断“无语音”。字幕时间跨度只衡量文字片段，不代表完整观影或正确率。缓存有效期 6 小时，以视频、分 P、读取版本与本地登录态摘要分隔；内容去重保留 CID 和文字版本。手动导入的来源保留未独立核实标记。

## 凭据与边界

默认匿名，不扫描浏览器、不自动查找旧账号、不随包携带凭据。需要 A2 时，使用者自己准备本地 JSON，字段 `sessdata`，在宿主插件 config 中设置 `credentialPath`。CLI 使用 `BILI_HUMANISM_CREDENTIAL_FILE` 指向文件，**不要把凭据值放到命令行、对话或 issue**。`disabled: true` 或 `read_valid: false` 会拒绝使用。

宿主配置示例（路径由自己填写，不要提交到公开仓库）：

```yaml
- id: bili-humanism
  name: dsh-bili-humanism
  config:
    dataDir: /your/private/bili-humanism
    credentialPath: /your/private/credential.json
    maxSessionTokens: 60000
    enableHistoryWrites: false
    enableFavoriteWrites: false
    writePolicyPath: /your/private/write-policy.json
    accountStateDir: /your/private/shared-account-state
```

SESSDATA 是高敏登录凭据，不是平台颁发的只读 token。读取入口使用固定 GET 接口；可选写入执行器另限历史与收藏两个 POST 路径，并需要本地 bili_jct、开关和有效授权；所有网络请求禁止重定向，凭据只向 `api.bilibili.com` 发送；日志不输出原始错误响应或令牌。受信任宿主代码和系统管理员仍能访问本机文件，不能把插件当成宿主整体的沙箱。字幕与标题是不可信数据，不能作为权限或删除记忆的授权；读取访问也不承诺零平台风险。

HTTP 401/403/412/429，以及已知账号/验证风险码，会记录持久暂停。重启也不自动解除；不会轮换 IP、账号或指纹。确认账号与使用条件后，使用者可在本地 CLI 显式执行：

```sh
bili-humanism resume --acknowledge-account-risk
```

模型工具不提供解除暂停。无自动重试。账本损坏或初始化后的账本丢失会拒绝启动，不悄悄重建一份空账本。

## 成本和本地 CLI

每个网络任务最多 12 次请求、3 个候选、90 秒；单个本地 ASR 任务最多 600 秒音频并受总墙钟限制。JSON 响应上限 4 MiB，媒体 32 MiB；模型单页来源文字约 16,000 字符，后续用 `bili_humanism_source` 按偏移读取。

若 DSH 提供 provider usage，插件从首次带计量的调用建立持久化会话基线，默认累计增量超过 60,000 tokens 后拒绝继续读取或改写记录。它包括同一宿主会话内的其他工作，不能精确归因给本插件；不能截断已发出的模型请求，单次请求可能越过额度。状态、取消、删除记忆、收件箱和已有来源查看仍可使用。缺计量时显示未知；已有计量突然消失或计数倒退会拒绝继续。CLI 网络任务不调用模型，结果中的 `tokens: null` 表示未取得模型用量，不能按零消耗解释。已在真实账号模型会话中取得宿主计量；超额拒绝逻辑仍以离线测试为依据，不把本次功能验收视作整场对话的费用上限证明。

```sh
node bin/cli.mjs read BVxxxxxxxxxx
node bin/cli.mjs status
node bin/cli.mjs inbox
node bin/cli.mjs journal READING_ID note.json
node bin/cli.mjs memory list
node bin/cli.mjs memory put understanding memory.json
node bin/cli.mjs memory delete understanding
node bin/cli.mjs audio READING_ID
node bin/cli.mjs local-asr READING_ID local-audio.m4s /local/model-directory
node bin/cli.mjs local-frames READING_ID local-video.mp4
node bin/cli.mjs import READING_ID segments.json
```

本地媒体适配器需 Python 3.10+，ASR 需 `faster-whisper`，抽帧需 `av` 和 `Pillow`。它们是可选实验能力，未纳入核心安装包的 Python 依赖锁定，须在自己的隔离环境安装；不自动下载模型。解码和模型加载期间可被父进程总时限终止。ASR 只能辅助结构和大意，专名要回源。画面抽样不是翻页检测器，教程可能漏页。

上面的 BV 是占位符，请替换为自己选择的视频。仓库只分发通用代码与合成测试夹具；私人手账、案例、观影内容和第三方媒体保存在本地，不进版本控制或发布附件。

## 验收与维护

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --ignore-scripts
```

见 [验收记录](docs/ACCEPTANCE.md)、[维护与升级](docs/MAINTENANCE.md)、[数据与安全](docs/SECURITY.md) 和 [贡献指南](CONTRIBUTING.md)。本版通过离线故障测试和真实宿主工具调用，不代表完成 7 天私人运行或 20 个代表视频基准。没有与其他插件运行同环境性能/精度对照；不宣称更快、更准或已经证明更有人文。

v0.1.0 历史记录：2026-10-20 补充真实 API 验收：通过 DSH 官方 stdio JSON-RPC 接口，在 `deepseek-account / deepseek-flash` 真实模型通道完成 3 轮会话、11 次插件工具调用，走通取稿、手账保存、记忆修正与删除、收件箱和状态查询；模型可见工具限制为本插件的 10 个工具。事件回执与本地账本交叉核对通过，没有 B站平台写入。具体视频、手账及完整会话不进入公开仓库；本次也不构成长期稳定性或人文质量基准。

工程格式依据 DeepSeek 官方 [工具开发](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.zh.md)、[插件安装](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md) 和 [SDK API](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/README.md)。来源整理见 [NOTICE](NOTICE.md)。MIT License。

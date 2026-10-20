# 遇见人 · dsh-bili-humanism

让 AI 在人的创作与生活中学习理解人，认真对待人。

这是可安装的 DeepSeek Harness 插件。它读取 B站视频的文字来源，保留作者、链接、分 P、时间点与未覆盖部分，再由宿主模型写成可以追问、修正的私人手账。艺术、日常、游戏、音乐和没有实用产出的观看都可以成为遇见；允许没有推荐、没有新发现。

**0.1.0 是预览版。** 本地收件箱是文件和 DSH 工具；本版没有独立侧栏或设置页。没有 B站评论、私信、动态、历史上报、点赞、投币、收藏、关注或投稿能力，也没有后台定时任务。公开发布与私人学习分开。

## 安装与开始

需要 Node.js 24+、DSH `0.2.1-rc.2`。只实测了 Windows 桌面发行包内置 CLI；其他版本和独立 CLI 尚未完成验收。

从 [Releases](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism/releases) 下载 `dsh-bili-humanism-0.1.0.tgz` 后：

```sh
dsh plugin --profile web add ./dsh-bili-humanism-0.1.0.tgz
dsh --profile web --dump-config
dsh --profile web
```

桌面版请在内置插件管理器安装同一包并重新加载；该界面安装路径尚未实测。也可将下面的 GitHub 固定标签地址交给 `dsh plugin add`：

```sh
dsh plugin --profile web add github:InariNGT-Ofiicial/dsh-bili-humanism#v0.1.0
```

发布入口是现成的 JavaScript，没有安装构建脚本。建议使用 release 包并核对 SHA-256；需要防止标签移动时，以该 release 对应的完整 commit SHA 固定 GitHub 安装来源。

在 DSH 对话中说：

> 先读取 bili_humanism_guide，再读取这个 BV。告诉我材料覆盖到哪里。若有值得记录的认识，用证据手账写入本地收件箱；如果没有，不必硬写。区分事实、作者观点和你的推测。

用 `bili_humanism_status` 查读取 ID 和任务，用 `bili_humanism_inbox` 看手账。数据默认在 `$DSH_HOME/bili-humanism/`，未设置 DSH_HOME 时在 `~/.dsh/bili-humanism/`。`inbox.html` 可以在 DSH 文件预览或浏览器中打开；同目录的 `inbox.md` 是文字版。两者没有外部资源请求。

## 已实现与限制

| 路线 / 能力 | 0.1.0 状态 |
|---|---|
| A2 官方 AI 文字来源 | 已实现并在一个视频实测 75 段；需要本机登录凭据。摘要/提纲不能冒充逐字稿 |
| A1 字幕轨 | 已实现并在同一视频实测 75 段；匿名读取可能没有字幕 |
| A3 本地 ASR | 有预算内的本地 Python 适配器与导入接口；需要自行安装依赖和已有本地模型，未完成真实推理验收 |
| 画面文字 | 有最多 40 张的本地抽样帧适配器与文字导入接口；需要宿主视觉模型阅读，尚无自动 OCR，抽样会漏页 |
| 理解与手账 | 宿主模型按指南整理；程序检查结构、出处时间点，语义准确与人文质量仍需人工审阅 |
| 记忆 | 可查看、覆盖修正、删除全部对应修订；只允许 AI 自我理解或使用者偏好，不接受第三方人格档案 |
| 任务控制 | SQLite 事务、任务互斥、缓存、结构化去重、取消、进程退出恢复、持久暂停 |
| 平台写入 | 没有注册或实现；只读也不承诺零平台风险 |
| 定时 / 私人通知 | 无后台定时任务；交付在本地收件箱，尚无外部私人通知适配器 |

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
```

SESSDATA 是高敏登录凭据，不是平台颁发的只读 token。插件的只读边界来自固定 GET 接口、精确域名和路径清单、禁止重定向、凭据只向 `api.bilibili.com` 发送；日志不输出原始错误响应或令牌。受信任宿主代码和系统管理员仍能访问本机文件，不能把插件当成宿主整体的沙箱。字幕与标题是不可信数据，不能作为权限或删除记忆的授权。

HTTP 401/403/412/429，以及已知账号/验证风险码，会记录持久暂停。重启也不自动解除；不会轮换 IP、账号或指纹。确认账号与使用条件后，使用者可在本地 CLI 显式执行：

```sh
bili-humanism resume --acknowledge-account-risk
```

模型工具不提供解除暂停。无自动重试。账本损坏或初始化后的账本丢失会拒绝启动，不悄悄重建一份空账本。

## 成本和本地 CLI

每个网络任务最多 12 次请求、3 个候选、90 秒；单个本地 ASR 任务最多 600 秒音频并受总墙钟限制。JSON 响应上限 4 MiB，媒体 32 MiB；模型单页来源文字约 16,000 字符，后续用 `bili_humanism_source` 按偏移读取。

若 DSH 提供 provider usage，插件从首次带计量的调用建立持久化会话基线，默认累计增量超过 60,000 tokens 后拒绝继续读取或改写记录。它包括同一宿主会话内的其他工作，不能精确归因给本插件；不能截断已发出的模型请求，单次请求可能越过额度。状态、取消、删除记忆、收件箱和已有来源查看仍可使用。缺计量时显示未知；已有计量突然消失或计数倒退会拒绝继续。CLI 网络任务不调用模型，结果中的 `tokens: null` 表示未取得模型用量，不能按零消耗解释。此接口适配尚未以真实付费模型对话验收。

```sh
node bin/cli.mjs read BV1d8pU6xEZX
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

`demo` 命令生成的是明确标注的**虚构合成手账**，仅用于展示界面和测试结构，不能作为产品真实观影效果。第三方视频文字、音频、图像只保存在使用者本地，不随代码或 release 再分发。

## 验收与维护

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --ignore-scripts
```

见 [验收记录](docs/ACCEPTANCE.md)、[维护与升级](docs/MAINTENANCE.md)、[数据与安全](docs/SECURITY.md) 和 [贡献指南](CONTRIBUTING.md)。本版通过离线故障测试和真实宿主工具调用，不代表完成 7 天私人运行或 20 个代表视频基准。没有与其他插件运行同环境性能/精度对照；不宣称更快、更准或已经证明更有人文。

工程格式依据 DeepSeek 官方 [工具开发](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.zh.md) 和 [插件安装](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)。来源整理见 [NOTICE](NOTICE.md)。MIT License。

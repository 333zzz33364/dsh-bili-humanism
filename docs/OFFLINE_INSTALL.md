# DSH B站内容学习插件 v1.8.0 离线安装说明

适用范围：Windows x64、DeepSeek Harness（DSH）`0.2.1-rc.2`、插件 `v1.8.0`。

本说明使用本地 `.tgz` 安装插件，不需要从 GitHub 克隆源码，也不运行构建或安装脚本。B站读取、账号登录和云端模型对话仍需要各自的网络连接。

## 安装前先核对 GitHub 版本

**无论由人还是 agent 执行，安装或更新前，只要当前网络连接与访问策略允许，就必须先到 [GitHub Releases](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism/releases) 核对版本号；存在与当前 DSH 兼容的较新版本时，下载并使用较新版本。不要把网盘中的 v1.8.0 固定当作最新版，也不要覆盖已经安装的更高版本。**

查看完整发布列表及对应发布说明，包括预览版标记、DSH 版本要求、验收范围与已知问题；不要只依赖可能不包含预览版的 `/releases/latest`。选择新版时，从同一 Release 下载 `.tgz` 和 `SHA256SUMS.txt`，按该版本说明安装。下文文件名和验收范围对应随附的 v1.8.0；选择新版时，以其文件名、同版校验文件和说明为准。

无法连接 GitHub 或访问策略不允许时，可以继续使用校验通过、与宿主兼容的离线包，并明确记录“未完成在线版本核对”；恢复允许连接后再核对。无需为检查版本绕过网络限制，也不因此启用后台任务或修改平台写入开关。

## 1. 准备文件

从 GitHub Release 安装时，直接下载同版 `.tgz` 与 `SHA256SUMS.txt`。如果从网盘取得离线分发，可能使用两个独立 ZIP（本说明不表示这些 ZIP 已上传）：

- `DeepSeek-Harness-0.2.1-rc.2-Windows-x64-Original.zip`：DSH 官方 Windows 安装器；已装好相同版本的用户可继续使用现有安装。
- `dsh-bili-humanism-v1.8.0.zip`：本插件安装包、说明和校验文件。

先安装 DSH，再解压插件 ZIP。进入内层 `dsh-bili-humanism-v1.8.0` 文件夹，应能看到：

```text
dsh-bili-humanism-1.8.0.tgz
SHA256SUMS.txt
README.md
安装说明.txt
```

保留 `.tgz` 原样即可，不必继续解压它。不要选择 GitHub 的源码 ZIP 代替本安装包。

## 2. 核对安装包

在上述文件夹的地址栏输入 `powershell` 并回车，打开 PowerShell。以下为随附 v1.8.0 的校验示例；如果已按前文选择新版，须将 `$PluginFile` 改为新版 `.tgz` 路径，并在同一目录放好同一 Release 的 `SHA256SUMS.txt`，再执行校验：

```powershell
$PluginFile = (Resolve-Path -LiteralPath '.\dsh-bili-humanism-1.8.0.tgz').Path
$ChecksumRows = @(Get-Content -LiteralPath '.\SHA256SUMS.txt' | ForEach-Object {
    $Fields = $_ -split '\s+', 2
    if ($Fields.Count -eq 2 -and $Fields[1].TrimStart([char]'*') -eq (Split-Path $PluginFile -Leaf) -and $Fields[0] -match '^[a-fA-F0-9]{64}$') {
        $Fields[0].ToLowerInvariant()
    }
})
if ($ChecksumRows.Count -ne 1) { throw '找不到唯一的对应 SHA-256，请取得同一 Release 的校验文件。' }
$ExpectedHash = $ChecksumRows[0]
$ActualHash = (Get-FileHash -LiteralPath $PluginFile -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualHash -ne $ExpectedHash) { throw '安装包校验不一致，请重新取得文件。' }
Write-Host 'SHA-256 校验通过'
```

此检查使用当前 `.tgz` 文件名匹配同一 Release 的校验文件，不把旧版哈希套用于新版。外层 ZIP 与内层 `.tgz` 的哈希不同，各自使用同目录对应的 `SHA256SUMS.txt`。

## 3. 使用 DSH 自带的 CLI 安装

如果终端已经能使用 `dsh` 命令，可直接跳到下一节。以下方法适用于只安装了 Windows 桌面版、终端提示“找不到 dsh”的情况，无需另外安装 Node.js 或全局 npm CLI。

继续在同一个 PowerShell 窗口执行。按提示输入实际的 `DeepSeek Harness.exe` 完整路径；可以在 DSH 快捷方式属性中查看安装位置。

```powershell
$DshExe = (Read-Host '请输入 DeepSeek Harness.exe 的完整路径').Trim().Trim('"')
if (-not (Test-Path -LiteralPath $DshExe -PathType Leaf)) { throw '找不到 DSH 程序，请检查路径。' }
$DshCli = Join-Path (Split-Path -Parent $DshExe) 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'

function Invoke-DshBundledCli {
    $PreviousRunAsNode = $env:ELECTRON_RUN_AS_NODE
    try {
        $env:ELECTRON_RUN_AS_NODE = '1'
        & $DshExe --expose-internals $DshCli @args
        if ($LASTEXITCODE -ne 0) { throw "DSH 命令失败，退出码：$LASTEXITCODE" }
    } finally {
        $env:ELECTRON_RUN_AS_NODE = $PreviousRunAsNode
    }
}

Invoke-DshBundledCli plugin --profile web add --offline --ignore-scripts $PluginFile
Invoke-DshBundledCli --profile web --dump-config
```

安装命令成功退出后，在配置输出中查找 `dsh-bili-humanism` / `bili-humanism` 对应层。然后完全退出并重新打开使用该 profile 的 DSH，或按宿主提供的方式重新加载。

这里使用 `web` profile。若实际会话使用其他 profile，须把两条命令中的 `web` 都改为那个 profile 的名字；不同 profile 的安装不会自动互通。上述命令使用当前用户现有的 DSH 主目录；只有你原本设置过自定义 `DSH_HOME` 时，才需要沿用自己的值。

## 4. 已有 dsh 命令时的简短方法

先完成第 2 节的校验，再在同一个 PowerShell 窗口执行，沿用已校验的 `$PluginFile`：

```powershell
dsh plugin --profile web add --offline --ignore-scripts $PluginFile
if ($LASTEXITCODE -ne 0) { throw '插件安装失败，请查看终端错误。' }
dsh --profile web --dump-config
```

`--offline` 要求包管理器只使用本地文件与缓存；`--ignore-scripts` 禁止依赖安装脚本。插件入口已是可执行 JavaScript，无需 `npm install`、`npm run build` 或批准构建脚本。

## 5. 确认插件可用

重新进入刚才安装的 profile，可让 DSH：

> 调用 bili_humanism_guide 和 bili_humanism_status，检查插件是否加载。先不要访问 B站或执行账号写入。

每日取稿默认关闭，默认启用人格积累，本插件注册 14 个工具；显式关闭人格积累时为 13 个。历史、收藏、点赞和投币分别默认关闭，评论接口保持关闭。

每份取稿的估算 token 上限在可信插件配置中使用 `maxReadTokens` 设置，默认 `600000`；可人工设高或设低，保存后重载，每份独立计额。旧 `maxSessionTokens` 继续兼容，新字段显式填写时优先。估算按正文 UTF-8 字节数保守计算，不是服务商账单上限。详见[取稿额度](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism/blob/main/docs/TOKEN_BUDGET.md)。

## 6. 常见情况

| 情况 | 处理方式 |
| --- | --- |
| 找不到 `.tgz` | 先解压外层 ZIP，并进入内层插件文件夹；不要在 ZIP 预览窗口内执行命令。 |
| 找不到 `dsh` | 使用第 3 节的桌面内置 CLI 方法。 |
| 提示版本不兼容 | 本说明仅验收 DSH `0.2.1-rc.2`。使用随附的对应版本，核对实际启动程序与所填路径一致。 |
| 出现 `ERR_PNPM_NO_OFFLINE_META` / `ERR_PNPM_NO_OFFLINE_TARBALL` | 当前宿主或 profile 还有未就绪的依赖缓存。停止离线安装，按 DSH 官方方式在联网环境准备对应依赖后再试；不要用关闭校验或批准未知脚本来绕过错误。 |
| 提示要下载 pnpm / 包管理工具 | 这台机器的包管理工具尚未就绪。当前两个 ZIP 不包含通用 npm/pnpm 离线缓存；先按官方方式准备工具。 |
| 安装成功但对话中没有工具 | 核对安装 profile 与实际执行会话的 profile，然后重启或重新加载。 |
| 无法登录模型或读取 B站 | 离线安装不提供这些在线服务，也不附带账号凭据。按各服务的正常方式配置。 |

本 ZIP 不包含本地 ASR 模型及 Python 推理依赖。最高 480p 视频抽帧还需另行准备固定 Python 依赖，并人工配置 `pythonPath`，见[本地抽帧说明](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism/blob/main/docs/LOCAL_FRAMES.md)。这些是可选功能，不是插件加载的前置条件；图片交付还要求当前模型明确支持图片输入。

## 7. 更新与数据保留

已有旧版插件时，先按“安装前先核对 GitHub 版本”选择较新且兼容的版本，校验后用相同的本地安装命令安装，再重载 profile；无法联网时沿用前述离线规则。更新前备份自己的私人数据目录，沿用现有开关和授权配置。

默认数据目录是 `$DSH_HOME/bili-humanism/`；未设置 `DSH_HOME` 时位于当前用户的 `~/.dsh/bili-humanism/`。更新、重装或回滚时保留手账、人格札记、账本、账号状态目录、风险暂停和待核对回执；不需要为安装插件删除这些数据。

## 验证范围与来源

已在 Windows DSH 桌面内置 CLI `0.2.1-rc.2` 中，用新的隔离 profile、空插件 store、`--offline`、禁用安装脚本及不可达的外部 HTTP 代理，完成 v1.8.0 `.tgz` 安装、配置层检查和 guide/status 工具调用。测试未使用用户 profile、账号凭据、真实模型或 B站请求。

这一结果验证上述条件下的插件离线安装；没有据此宣称在全新 Windows 系统上从零准备所有工具的流程已验收。桌面插件管理界面的离线导入未单独验收。

- [插件 v1.8.0 发布页](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism/releases/tag/v1.8.0)
- [DSH 官方插件安装文档（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/develop/basic/publish.zh.md)

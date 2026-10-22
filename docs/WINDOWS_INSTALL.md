# Windows 桌面安装三步

适用已安装 Windows DSH Desktop `0.2.1-rc.2`、终端找不到 `dsh` 命令的情况。本插件尚未收录进推荐插件市场的精选目录；市场搜索或粘贴仓库 URL 的安装失败，不会阻止桌面自带 CLI 安装本地发布包。

先确认当前会话实际使用的 **profile 名称和 DSH 主目录**。启动脚本若设置了 `DSH_HOME`，在下面的 PowerShell 中沿用同一值；已有桌面程序不会自动读取另一个终端刚改的环境变量。`web` 只是独立 CLI 文档中的例子，不代表当前桌面会话的 profile。更新已有安装前，备份自己实际 profile 的 `package.json` 和 `cordis.patch.yml`。

## 1. 下载并校验发布包

打开完整的 [GitHub Releases 列表](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism/releases)，选择与当前 DSH 兼容的版本，留意预览版标记。从**同一条 Release** 下载 `.tgz` 安装包和 `SHA256SUMS.txt`。不要用 GitHub 的 `Source code.zip` 代替发布包，也不要把源码目录的 `node_modules` 当成安装包。

在 PowerShell 中执行以下代码，按提示输入下载文件的完整路径；路径可包含空格：

```powershell
$ErrorActionPreference = 'Stop'
$Package = (Resolve-Path -LiteralPath ((Read-Host '请输入 .tgz 安装包的完整路径').Trim().Trim('"'))).Path
$Checksums = (Resolve-Path -LiteralPath ((Read-Host '请输入同一 Release 的 SHA256SUMS.txt 完整路径').Trim().Trim('"'))).Path
if ([IO.Path]::GetExtension($Package) -ne '.tgz') { throw '请选择 Release 中的 .tgz 安装包' }
$ChecksumRows = @(
    foreach ($Line in Get-Content -LiteralPath $Checksums) {
        $Match = [regex]::Match($Line, '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$')
        if ($Match.Success -and $Match.Groups[2].Value -eq [IO.Path]::GetFileName($Package)) {
            $Match.Groups[1].Value
        }
    }
)
if ($ChecksumRows.Count -ne 1) { throw '校验文件没有唯一对应的安装包记录，请重新下载同一 Release 的两个文件' }
if ((Get-FileHash -LiteralPath $Package -Algorithm SHA256).Hash -ne $ChecksumRows[0]) { throw 'SHA-256 不匹配，请停止安装并重新下载' }
Write-Host '安装包 SHA-256 校验通过'
```

## 2. 用桌面自带 CLI 安装

完全退出 DSH。在**同一个 PowerShell 窗口**继续执行，输入已安装的 `DeepSeek Harness.exe` 路径和刚确认的 profile 名称。可以在桌面快捷方式的属性中查看程序位置。

```powershell
$DshExe = (Resolve-Path -LiteralPath ((Read-Host '请输入 DeepSeek Harness.exe 的完整路径').Trim().Trim('"'))).Path
$DshCli = Join-Path (Split-Path -Parent $DshExe) 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$ProfileName = (Read-Host '请输入当前会话实际使用的 profile 名称').Trim()
if ([string]::IsNullOrWhiteSpace($ProfileName)) { throw 'profile 名称不能为空' }
$PreviousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $DshExe --expose-internals $DshCli plugin --profile $ProfileName add --offline --ignore-scripts $Package | Out-Host
    if ($LASTEXITCODE -ne 0) { throw '安装未完成，请保留终端错误并检查包版本、DSH 版本和 profile' }
} finally {
    $env:ELECTRON_RUN_AS_NODE = $PreviousElectronRunAsNode
}
```

`plugin add` 会由宿主管理该 profile 的 `dependencies` 和 `dsh.profile.bundles`。安装及更新都使用这条命令；保留 profile 中其他插件与配置。发布包包含可直接运行的 JavaScript，不需要构建脚本。这里的 `--offline --ignore-scripts` 已用完整发布包在固定桌面版本验收；若离线安装提示缺少其他包，先检查是否使用了完整、兼容的 Release 安装包。

## 3. 重开同一 profile 并确认工具

按原启动方式重新打开 DSH，进入安装时指定的同一 profile，发送：

> 请调用 bili_humanism_guide 和 bili_humanism_status，确认插件已加载。暂时不要访问 B站或执行账号写入。

两个工具可用后，再按[使用与配置入口](GETTING_STARTED.md)配置读取和可选抽帧。凭据、Python 和平台写入权限都不是这两个工具的前置条件。

若仍缺少工具，先核对启动时的 `DSH_HOME`、profile、宿主加载错误和实际安装包版本。`plugin is not in the curated registry` 表示走的是市场精选目录入口；本页使用的是桌面内置 CLI 的本地包入口。市场目录尚未收录本插件，本文不宣称桌面市场一键安装已经通过验收。

## 验证范围与来源

此路径已用 Windows 桌面内置 CLI `0.2.1-rc.2` 在全新隔离主目录/profile 中安装 v1.5.0 发布包，验证 `dependencies`、bundle 注册、重复安装后原 profile 配置保留及 `guide`/`status` 工具加载。测试没有接触使用者现用 profile、账号凭据、真实模型或 B站请求；市场图形界面安装未验收。最终新版本的验收记录随 Release 更新。

宿主契约：[固定版本的组合包、profile 与本地 tarball 安装](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/develop/basic/publish.zh.md)。市场目录：[awesome-dsh-plugin 收录规则](https://github.com/beancookie/awesome-dsh-plugin/blob/main/contributing.md)、[市场读取的 registry 来源](https://github.com/beancookie/dsh-plugin-registry/blob/main/src/registry.ts)。目录收录需维护方合并、生成并由市场刷新；准备条目或提交申请不等于已经可一键安装。

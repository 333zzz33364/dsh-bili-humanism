# 本地抽帧依赖与宿主读图

只把视频链接交给插件，当前不会自动识别画面。`bili_humanism_read` 获取字幕或 A2 文字；本地抽帧需自行准备视频文件，之后由支持读图的宿主查看图片。插件提供画面文字导入，未内置视觉模型、OCR 或模型下载器。

## 安装可选抽帧依赖

Python 3.10 以上；固定使用 [PyAV `av==16.1.0`](https://pypi.org/project/av/16.1.0/) 和 [Pillow `12.3.0`](https://pypi.org/project/pillow/12.3.0/)。这两个版本支持 Python 3.10 以上，PyPI 提供 Windows amd64 的 cp310 至 cp314 wheel；其他系统和架构以实际 wheel 可用性为准，不表示已完成跨平台实测。`numpy`、`faster-whisper` 与 ASR 模型不是本抽帧路径的必需依赖。先创建专用虚拟环境，再以同一个解释器安装、诊断和执行抽帧；不要修改全局 Python 环境。

PyAV 官方说明其二进制 wheel 已链接 FFmpeg 库；本脚本直接使用 PyAV 解码，不调用系统 `ffmpeg.exe`，因此按本说明成功安装官方 wheel 后，此抽帧路径不要求另装 FFmpeg 命令行程序。源码编译或其他软件的 FFmpeg 需求另论，见 [PyAV 安装说明](https://pypi.org/project/av/16.1.0/#description)。

Windows PowerShell，在源码根目录执行：

```powershell
python -m venv .venv-frames
.\.venv-frames\Scripts\python.exe -m pip install --only-binary=:all: -r scripts/requirements-frames.txt
.\.venv-frames\Scripts\python.exe scripts/frame_environment.py doctor
.\.venv-frames\Scripts\python.exe scripts/frame_environment.py smoke
$env:BILI_HUMANISM_PYTHON = (Resolve-Path .\.venv-frames\Scripts\python.exe).Path
```

macOS / Linux，在源码根目录执行：

```sh
python3 -m venv .venv-frames
.venv-frames/bin/python -m pip install --only-binary=:all: -r scripts/requirements-frames.txt
.venv-frames/bin/python scripts/frame_environment.py doctor
.venv-frames/bin/python scripts/frame_environment.py smoke
export BILI_HUMANISM_PYTHON="$PWD/.venv-frames/bin/python"
```

源码的 npm 打包清单包含两个 Python 脚本和依赖清单；本次先更新 GitHub 源码，已发布的旧 release tarball 不会因此改变。旧包没有新增文件时，请从 GitHub 仓库取得包含本说明的源码；后续由该源码构建的新包才会携带这些文件。若从这样的 npm 包使用，将命令中的 `scripts/` 改为该安装包内的实际脚本目录，虚拟环境放在自己的私有工作目录。npm 安装不会执行 pip 或安装 Python 依赖。`--only-binary` 在当前 Python/平台没有匹配 wheel 时明确失败，不会自动改成从源码编译；请选择存在官方 wheel 的 Python/平台后重试。

`BILI_HUMANISM_PYTHON` 由启动 DSH 的进程继承；在另一个终端设置不保证已经运行的 Desktop 进程能看到。先在同一个终端用本地 CLI 验证，并让宿主采用同一个已确认的解释器路径。

## doctor 与 smoke 的含义

`doctor` 实际导入 `av` 和 `PIL.Image`，以 JSON 返回版本、固定版本匹配结果、缺失依赖及 Python 版本支持情况。依赖不可用、版本不符或 Python 版本不支持时退出码为 2。它不会尝试安装、下载模型、读取凭据或调用 B站。

`smoke` 生成四秒的合成四色视频，调用发行的 `media.py frames`，检查四张 JPEG 的尺寸、时间戳和颜色，结束后删除临时媒体。通过时只说明本机解码、抽样和图片输出可用。`host_vision.status` 保持 `not_tested`，不是完整画面理解验收，也不是实际视频质量结论。诊断和 smoke 均不访问平台或视觉服务。

## 从图片到可追溯的文字

先取得自己有权处理的本地视频，并用同一视频的 reading ID 抽帧：

```sh
node bin/cli.mjs local-frames READING_ID local-video.mp4
```

返回目录中包含 `manifest.json` 和 JPEG。把实际图片交给支持图片输入的宿主，连同 manifest 时间戳让它阅读；没有图片或宿主不支持读图时，不能把字幕推断说成看到了画面。均匀抽样最多 40 张，可能漏掉页、按钮状态和运动细节，不是逐页检测。

宿主读图后生成本地 `visual-text.json`；下面仅为合成格式示例：

```json
{
  "route": "frame",
  "segments": [
    { "start": 5, "end": 6, "text": "合成示例：该帧上可见的文字；不清晰处保留不确定性。" }
  ]
}
```

```sh
node bin/cli.mjs import READING_ID visual-text.json
```

也可由宿主调用已注册的 `bili_humanism_import`；`json` 参数必须是序列化后的 JSON 字符串，不是嵌套对象，例如：

```json
{
  "readingId": "READING_ID",
  "json": "{\"route\":\"frame\",\"segments\":[{\"start\":5,\"end\":6,\"text\":\"合成画面文字\"}]}"
}
```

按导入结果返回的来源 ID 调用 `bili_humanism_source` 查看；保存状态为 `visual_text_partial`，不会冒充语音稿，也不保证对画面含义的判断正确。图片、源视频、导入正文和私人阅读记录留在本地，不加入仓库或 release 附件。

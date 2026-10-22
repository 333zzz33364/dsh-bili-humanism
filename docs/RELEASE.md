## DSH B站内容学习插件 v1.5.0

取消音频下载、ASR 和抽帧默认的 600 秒拦截，未配置时不再按固定来源时长拒绝长视频。画面按全片时长均匀采样，最多 40 帧；不静默截取前十分钟。可选 `maxMediaSeconds` 由使用者在可信 profile 配置中设置，模型不能修改。32 MiB 下载、90 秒处理、12 请求、最高 480p 及其他附件和账号边界继续生效，长视频仍可能因大小或超时失败。

README 第一屏增加 Windows 桌面安装三步，使用桌面内置 CLI 和同一 profile，无需 PATH 中存在 `dsh`，无需手工复制 node_modules 或改依赖清单。市场仍待目录收录；本版本不宣称市场一键安装已完成。

合并 v1.4.1 的每份取稿独立 token 额度：默认 600,000，按正文 UTF-8 字节数保守估算。支持人工 `maxReadTokens` 及兼容的 `maxSessionTokens`，新字段优先；不累计常驻会话其他工作的用量，也不拦截手账或人格选句。该估算不是模型实际计费上限。

118 项离线测试、七项真实 PyAV 合成媒体检查、最终包 Service 到实际 Python 链路、27 个隔离真实宿主配置场景及安装页原样 PowerShell 步骤通过。图片附件哈希回读、4+1 帧分页、中间视频清理及重复安装配置保留通过。验证使用合成平台与媒体，没有真实 B站请求、账号写入、ASR 推理或模型调用，不声明完整观影与语义准确率。

人格积累默认开启；历史、收藏、点赞与投币独立默认关闭，评论接口继续关闭。原账本、账号额度与风险暂停保留。JavaScript bundle 无 prepare/build 或自动 pip 安装脚本；回滚旧版本可能恢复旧时长或会话门限，不删除账本和暂停。

从同一 Release 下载 `dsh-bili-humanism-1.5.0.tgz` 与 `SHA256SUMS.txt` 并校验后，按 [Windows 桌面安装三步](WINDOWS_INSTALL.md)更新并重载。可选 Python 环境见[抽帧依赖](LOCAL_FRAMES.md)，人工时长设置见[媒体预算](MEDIA_LIMITS.md)，取稿额度见[TOKEN_BUDGET.md](TOKEN_BUDGET.md)。本版继续为预览版。

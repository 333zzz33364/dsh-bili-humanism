# 人类用户的写入配置（1.1.0）

历史与收藏由使用者自己判断是否开启。执行器有离线模拟测试；真实 DSH 安装只验证配置、注册和拒绝边界，没有向真实 B站账号写入。首次使用由本人选择有权管理的账号及少量具体目标，核对平台结果；测试夹具不构成平台兼容性证明。

## 开关

DSH 插件可信 config 默认如下；只有 true 才注册对应工具，变更后重载插件。

```yaml
enableHistoryWrites: false
enableFavoriteWrites: false
writePolicyPath: /your/private/write-policy.json
accountStateDir: /your/private/shared-account-state
```

授权文件在每次网络请求前重读，设 `enabled: false` 或删除文件可阻止后续请求。关闭配置开关并重载会移除工具；仍在执行的任务应先取消。已经发出的请求可能生效。

账号状态默认在 `$DSH_HOME/bili-humanism-accounts/账号UID/`，未设置 DSH_HOME 时在 `~/.dsh/` 下。同一账号的所有 profile 必须共用 `accountStateDir`，才能共享互斥、额度与暂停。不能改路径或删账本绕过暂停；原 agent 的写入与调度须由使用者先停用，本插件不会自动停止外部程序。

## 本地授权文件

以下是合成账号、收藏夹与视频，保持关闭且已过期。本人填写账号 UID、目标、收藏夹、有效期和额度，核对可见性，再将相应 enabled 改为 true；handoverConfirmed 表示确认有权管理且已完成交接。不要提交真实文件或粘贴凭据到聊天。

```json
{
  "version": 1,
  "id": "my-reviewed-grant-1",
  "enabled": false,
  "handoverConfirmed": false,
  "accountId": "123",
  "expiresAt": "2000-01-01T00:00:00Z",
  "videos": ["BV0000000001"],
  "allReadings": false,
  "history": { "enabled": false, "maxWrites": 10 },
  "favorites": {
    "enabled": false,
    "maxWrites": 10,
    "folders": [{ "id": "456", "visibility": "private", "allowRemove": false }]
  }
}
```

账号与收藏夹 ID 使用数字字符串。videos 限定视频；若本人决定授权本地已读取的所有视频，可设 `allReadings: true`，工具仍只引用已有读取 ID。`maxWrites` 是该账号、授权 ID 和能力的累计发送额度，1–100；失败且结果不明的发送也占额度，重启不重置。修改授权 ID 属于本人重新签发额度，不能绕过平台暂停。另有账号级至少 60 秒一次的发送间隔，不自动排队或重试。

收藏夹 visibility 支持 private / public，必须与平台属性一致；变化会拒绝执行。`allowRemove: true` 独立授予移除该收藏夹内容的权限。没有新建或删除收藏夹、清理历史的工具。

平台不提供这些请求间的原子锁；外部同时修改收藏夹可见性，可能在发送生效后才被回读发现。此时暂停并交由本人核对，不能保证自动恢复原状。

`credentialPath` 仍由可信宿主配置指定。写入额外要求本地 JSON 有 bili_jct 字段（CSRF 值）；它与 sessdata 都是敏感值，不进入工具参数或日志。disabled: true、read_valid: false、write_valid: false 均不能写入。

## 调用

收藏工具 `bili_humanism_favorite` 接受 readingId、授权的 folderId、action: add/remove。执行器核对实际登录账号、视频元信息、收藏夹归属及可见性；已有目标状态时不重复发送，发送后回读对应收藏夹状态。

历史工具 `bili_humanism_history` 只接受 readingId 和 consumptionId。本人在确实消费相应内容后，用可信本地 CLI 确认秒数：

```sh
bili-humanism consumed READING_ID 20 --acknowledge-actual-consumption
```

回执是本人确认的记录，不是自动播放器计量证明，不能仅凭字幕覆盖率生成。模型没有生成消费回执的工具，不接受 -1“看完”或超时长进度。执行器不回退已知或本次回读的更高进度；发送后查最近 30 条历史中匹配稿件与 CID 的进度，未匹配即按未知处理。即使可能只是平台延迟，也不自动重试。

CLI 配置用 BILI_HUMANISM_CONFIG_FILE 指向本地 JSON，字段同 DSH config。CLI 支持 `history READING_ID CONSUMPTION_ID` 和 `favorite READING_ID FOLDER_ID add/remove`，同样经过执行器。模型工具不能传入路径、开关、凭据或授权。

## 暂停与结果不明

`bili_humanism_status` 显示开关、授权概况、账号暂停、待核对操作和最近回执。操作先持久化意图再发送。超时、重定向、解析失败、平台错误或回读不一致时，请求可能已处理；保留待核对意图并暂停，不声称已经回滚。

本人先到平台核对具体目标，再记录结果；未生效时把 applied 换成 not-applied：

```sh
bili-humanism write-resolve OPERATION_ID applied --acknowledge-unknown-result
bili-humanism write-resume --acknowledge-account-risk
bili-humanism resume --acknowledge-account-risk
```

核对记录不撤销平台操作，不清空额度、间隔或风险暂停。后两步分别明确解除账号写入暂停和当前本地任务暂停；待核对意图未处理时，不能解除账号写入暂停。模型没有核对、解除或消费确认工具。迁移、重启与回滚都保留这些状态。

接口依据社区原始调查，未获平台稳定性承诺：[进度上报](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/video/report.md)、[历史读取](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/historytoview/history.md)、[收藏操作](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/video/action.md)、[收藏夹属性](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/fav/info.md)。仅发送两个 POST：/x/v2/history/report 和 /x/v3/fav/resource/deal，不发送播放心跳。

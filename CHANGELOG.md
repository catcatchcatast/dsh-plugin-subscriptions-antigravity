# 变更记录

## 0.9.14-local.13

- 同步 [bridge `23a7ce24`](https://github.com/catcatchcatast/dsh-antigravity-bridge/commit/23a7ce24e0bcb11f062e73c7acedcd17a66321d5)：检测工作进程漏挂 DSH 工具；若在本轮结束时发现，单个请求最多自动重试一次。
- Detect missing DSH tools at worker startup or turn end; recovery at turn end retries at most once per request.

## 0.9.14-local.12

- 同步 [bridge `04ab8944`](https://github.com/catcatchcatast/dsh-antigravity-bridge/commit/04ab8944ac7d545f8d2e94b4c75e397f149eea69)：确认工具取得进展后重置连续空闲重试计数。
- Confirmed tool progress resets the consecutive idle-retry count.

## 0.9.14-local.11

- 同步 [bridge `340ca1ec`](https://github.com/catcatchcatast/dsh-antigravity-bridge/commit/340ca1ec4474551714d2a6f98244e7fc810ab3fd)：超时续接沿用当前步骤输入和已保存的工具结果；重试用尽时提示是否有部分正文及本轮可识别的生成错误。
- Idle recovery reuses the current input and saved tool results. When retries run out, the bridge reports partial output and any recognized generation error for this turn.

## 0.9.14-local.10

- `agy` 未提供额度重置时间时，不再把零时间戳标为「已过」。明细显示 `—`，保留 `0%` 和实际重置时间的显示。
- Treat the `agy` epoch reset timestamp as unknown. Quota details show `—` while still showing `0%` usage and actual reset times.

## 0.9.14-local.9

- 同步 [bridge `92b178e0`](https://github.com/catcatchcatast/dsh-antigravity-bridge/commit/92b178e00bc37c128ec1353b267f4288f8e6a6f1)。长历史分片交接停滞时，收到 ACP 取消回执后才重发同一分片；与当前回答共享最多五次自动续接的预算。
- Sync [bridge `92b178e0`](https://github.com/catcatchcatast/dsh-antigravity-bridge/commit/92b178e00bc37c128ec1353b267f4288f8e6a6f1). A stalled history fragment is retried only after ACP acknowledges cancellation, using the same five-retry budget as the active answer.

## 0.9.14-local.8

- 同步 [bridge `556c7d1`](https://github.com/catcatchcatast/dsh-antigravity-bridge/commit/556c7d1486c9cc094de548db8ab48119025d3614)。模型停滞后自动续接时，允许重新查询任务输出、代理列表、文件和搜索结果。其他已完成工具若以相同参数再次调用，仍暂停确认。
- 保留紧凑额度表、Google 账号额度 5 分钟后台预读和模型可见性管理。

## 来源

订阅插件基于 [V1ki/dsh-plugin-subscriptions `c58464c`](https://github.com/V1ki/dsh-plugin-subscriptions/commit/c58464c92f86b03ca99e2706d5573f1db8bcf4fb)。内置 bridge 使用其官方后端模块，不另行挂载原 bridge 的客户端。

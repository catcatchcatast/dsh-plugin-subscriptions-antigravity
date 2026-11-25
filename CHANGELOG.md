# 变更记录

## 0.9.14-local.8

- 同步 [bridge `556c7d1`](https://github.com/catcatchcatast/dsh-antigravity-bridge/commit/556c7d1486c9cc094de548db8ab48119025d3614)。模型停滞后自动续接时，允许重新查询任务输出、代理列表、文件和搜索结果。其他已完成工具若以相同参数再次调用，仍暂停确认。
- 保留紧凑额度表、Google 账号额度 5 分钟后台预读和模型可见性管理。

## 来源

订阅插件基于 [V1ki/dsh-plugin-subscriptions `c58464c`](https://github.com/V1ki/dsh-plugin-subscriptions/commit/c58464c92f86b03ca99e2706d5573f1db8bcf4fb)。内置 bridge 使用其官方后端模块，不另行挂载原 bridge 的客户端。

# DSH 订阅插件 · Antigravity 版

[English](README.en.md) · [变更记录](CHANGELOG.md)

在 DeepSeek Harness 中使用 Codex、Claude、GitHub Copilot、Grok 订阅，并通过官方 `agy` CLI 使用 Google Antigravity 模型。这是 [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions) 的衍生版本，包名保留 `dsh-plugin-subscriptions`，用于替换原插件，不要并装。

## 安装

需要兼容的 DSH、Node.js 和 Corepack/pnpm。先从本仓库源码生成安装包：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run build
npm pack --ignore-scripts
```

在目标设备上安装到实际使用的 profile（下例为 `web`），再重启对应的 DSH 应用或服务：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-plugin-subscriptions-0.9.14-local.8.tgz
```

## 使用

- **Google**：在实际执行会话的主机上安装官方 `agy` 并完成登录。本包已内置 bridge 后端，不要再挂载独立 bridge。已有独立安装时先备份 profile，迁移时保留 `llm-antigravity-acp` 配置和 CLI 登录数据。
- **模型列表**：打开「设置 → 订阅 → Antigravity → 管理」，勾选要在模型选择器中显示的模型。这里筛选 CLI 公布的模型，不会授予账号原本没有的权限。
- **额度**：点击状态栏徽章，按账号查看额度项、百分比和距重置时间。Google 账号额度会在后台预读，两次自动查询至少相隔 5 分钟；打开弹层不会额外查询。

## 开发与验证

```sh
corepack pnpm test
node --test test/bridge-bundle.mjs
```

先执行上面的构建命令，再运行集成测试。源码在 `src/`，测试在 `test/`。内置的 [Antigravity bridge](https://github.com/catcatchcatast/dsh-antigravity-bridge/tree/556c7d1486c9cc094de548db8ab48119025d3614) 固定到 `556c7d1`；只引入后端模块，不加载第二套前端。

## 许可

保留[原项目许可证](LICENSE)、[bridge 许可证](vendor/antigravity-bridge/LICENSE)和[第三方声明](LICENSES/)。

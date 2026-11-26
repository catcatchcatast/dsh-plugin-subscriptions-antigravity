# DSH Subscriptions with Antigravity

[中文](README.md) · [Changelog](CHANGELOG.md)

This derivative of [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions) provides subscription-backed models for DSH. Google models use the official `agy` CLI through the bundled [Antigravity bridge](https://github.com/catcatchcatast/dsh-antigravity-bridge/tree/92b178e00bc37c128ec1353b267f4288f8e6a6f1). Install and sign in to `agy` on the host serving the session. Do not install a second copy of the bridge or the upstream subscriptions plugin in the same profile.

## Build and install

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm test
node --test test/bridge-bundle.mjs
npm pack --ignore-scripts
dsh plugin --profile web add /absolute/path/to/dsh-plugin-subscriptions-0.9.14-local.10.tgz
```

Replace `web` with your target profile and restart its DSH application or service. In **Settings → Subscriptions → Antigravity → Manage**, choose which CLI-advertised models appear in the model picker. The status-bar badge shows quota usage and reset times. Google accounts are prefetched with at least five minutes between automatic queries; opening the popover does not trigger another query. When `agy` does not provide a reset time, the details show `—` rather than an expired reset; zero usage still shows `0%`.

See the [project license](LICENSE), [bridge license](vendor/antigravity-bridge/LICENSE), and [third-party notices](LICENSES/).

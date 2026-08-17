<table>
<tr>
<td width="42%" valign="top">

# dsh-meter

[English](README.md) | 中文

### DeepSeek 开始按时段计价了，这是配套的电表。

每天两段高峰，空闲时段半价。花费不再是事后翻账本才看的数字，而是**你此刻正站在里面的费率**。

输入框下面一行：这个会话花了多少、当前是哪一档、还有多久换档。悬停展开卡片，里面是时段表、缓存的经济账，以及账户余额。

[![site](https://img.shields.io/badge/site-dsh.works%2Fdsh--meter-00c2e9)](https://dsh.works/dsh-meter/)
[![ci](https://github.com/dshworks/dsh-meter/actions/workflows/ci.yml/badge.svg)](https://github.com/dshworks/dsh-meter/actions/workflows/ci.yml)
[![powered by dsh](https://img.shields.io/badge/powered__by-dsh-4D6BFE?logo=deepseek)](https://github.com/deepseek-ai/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</td>
<td width="58%" valign="top">

<img src="https://raw.githubusercontent.com/dshworks/dsh-meter/main/docs/meter-light.png" alt="输入框下方的计价行与展开的卡片：会话总价、时段表、缓存与输入拆解、账户余额" width="420">

</td>
</tr>
</table>

## 安装

```sh
dsh plugin --profile web add @dshworks/dsh-meter
dsh --profile web
```

`dsh plugin` 转发给 pnpm，因此 PATH 里要有 pnpm。除此之外无需配置：会话产生第一次计费请求后，计价行就会出现在输入框下方。

## 那一行

```
2 turns · 2 steps | LLM 3.1s | TTFT avg 1.3s · 41 tok/s | Cache hit 50% | Input 44.3K tok
                    ¥0.0672  |  peak  |  off-peak in 48m
```

上面是 dsh 自带的统计行，原样保留；下面才是本插件。它**新增**一行，而不是抢占官方那一格——想在官方统计行里追加内容，只能用同 id 更低 priority 把它顶掉，那样每次上游改动都会跟着坏。

悬停或聚焦展开卡片。处在高峰时段时，档位用琥珀色标出，倒计时指向下一个空闲时段：

<img src="https://raw.githubusercontent.com/dshworks/dsh-meter/main/docs/meter-dark.png" alt="暗色主题下处于高峰时段的同一张卡片" width="620">

| 卡片里有什么 | 为什么值得占这个位置 |
|---|---|
| 会话总价、请求数、模型 | 这个数字只出现一次，用最大的字号 |
| 24 小时时段条，按**你所在时区**绘制，带实时游标 | 官方按 UTC 公布高峰窗口。深夜心算时区不如直接看一条 |
| 缓存命中 / 未命中输入 / 输出，各自的 token 与金额 | 命中价只有未命中的 **1/30**。这一行能看出前缀是否稳定 |
| 账户余额，以及其中多少是赠送额度 | 赠送额度会过期，充值余额不会 |
| 同样的 token 换到另一档要多少钱 | 调价前：看新价会让这个会话变成什么样；调价后：看等到空闲时段能省多少 |
| 缓存省下了多少 | 把每一次命中都按未命中重算出来的对照值 |

## 验证

2026-08-15 对 dsh `0.1.0-rc.6` 做过真实验证，DeepSeek-V4-Pro 真实会话，不是 mock：

| 结论 | 怎么验的 |
|---|---|
| 能在标准 web profile 里加载 | `dsh --profile web --dump-config` 能列出；`/plugins/@dshworks/dsh-meter/client.js` 返回 200 |
| 读数正确 | v4-pro 统一价下 22.2K 未命中输入 = ¥0.0665；那一行与卡片同 dsh 自己的 token 统计一致 |
| 重启后仍在 | 重启服务、冷启动重开会话，投影从持久日志重放出同一个数 |
| 两种主题、两种档位 | 亮色/暗色、统一价/高峰，见上图——截图早于 8/16 切换，其中的统一价读数是新会话已不会再出现的状态 |
| 币种自动识别 | 真实账号返回 `{"currency":"cny", ...}`，整个界面无需配置直接切到 ¥ |
| 50 个测试，CI 绿 | `pnpm test` — 折叠逻辑、时段时钟、价目表、余额读取，外加生成产物的同步校验 |

## 两种货币，不做换算

DeepSeek 公布的是**两张互相独立的价目表**——国际站按美元，中国站按人民币。一个账号只按其中一张计费，两张表也不是彼此的汇率换算，所以用汇率去折算的插件会错两次。

`dsh-meter` 两张表都算，然后让账号自己决定用哪张。`GET /user/balance` 会返回该账号的计价币种（真实账号会同时列出两行，只有一行有余额），插件读有余额的那一行并按它显示。不需要配置，也不靠界面语言去猜。

余额请求跑在宿主侧，用的是 LLM adapter 同一套凭据接口；浏览器通过 `GET /dsh-meter/balance` 只拿到解析好的数字，拿不到 key。它只在计价行挂载和你展开卡片时发出，不做轮询——设 `balance: false` 可以整个关掉，计价功能不受影响。

## 价目表

原样写在 [`lib/core.js`](lib/core.js) 里，单位为每百万 tokens。

| | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| **v4-flash** 空闲 | $0.007 / ¥0.05 | $0.22 / ¥1.5 | $0.66 / ¥4.5 |
| v4-flash 高峰 | $0.014 / ¥0.10 | $0.44 / ¥3 | $1.32 / ¥9 |
| **v4-pro** 空闲 | $0.022 / ¥0.15 | $0.66 / ¥4.5 | $1.98 / ¥13.5 |
| v4-pro 高峰 | $0.044 / ¥0.30 | $1.32 / ¥9 | $3.96 / ¥27 |

高峰为 **UTC 01:00–04:00 与 06:00–10:00**（北京时间 09:00–12:00、14:00–18:00）。其余时间都是空闲时段，包括两个窗口之间那两小时。空闲价正好是高峰价的一半——但仍高于它取代的统一价，输出约为 2.3 倍。

<details>
<summary>已退役的统一价，保留用于回算历史</summary>

在 **UTC 2026-08-16 16:00** 之前全天按此计费。官方页面已不再列出它；电表保留它，是因为切换前记录的会话必须仍按当时真实的价格计算。

| | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| **v4-flash** 统一价 | $0.0028 / ¥0.02 | $0.14 / ¥1 | $0.28 / ¥2 |
| **v4-pro** 统一价 | $0.003625 / ¥0.025 | $0.435 / ¥3 | $0.87 / ¥6 |

相较于它，v4-pro 缓存命中输入涨到 6 倍（高峰 12 倍）、缓存未命中输入 1.5 倍（高峰 3 倍）、输出 2.3 倍（高峰 4.6 倍）。涨幅最陡的正是最便宜的那种 token，也正是 agent 发得最多的那种。

</details>

来源：<https://api-docs.deepseek.com/quick_start/pricing>，于 2026-08-17 重新核对——并且核对过真实账单：v4-pro 一次 188,542 缓存未命中 tokens 的调用，空闲时段实扣 ¥0.84，即每百万 ¥4.46，对应公布的 4.5。

## 钱是怎么算出来的

| 行为 | 细节 |
|---|---|
| 数据来源 | 持久会话日志里由供应商上报的 token 数。不采样，不推测 |
| 每次请求的档位 | 按**发出**时刻（`step/start`）判定，而不是按回答结束的时刻。UTC 00:59 发出的请求即使流式输出跨进高峰窗口，仍按空闲价计；跨档会话的两侧各按各的档位算 |
| 计费桶 | `inputTokens` 按未命中价，`cacheReadTokens` 按命中价，`outputTokens` 按输出价。dsh 上报的是互不重叠的三个数（DeepSeek adapter 会从 `prompt_tokens` 里减掉命中部分），推理 token 已包含在输出里 |
| 缓存写入 | 并入未命中桶。DeepSeek 没有单独的写入价，首次进入缓存的 prompt 按未命中计；DeepSeek adapter 也从不上报这一项 |
| 失败的请求 | 某一步的 usage chunk 即使请求随后失败也会计入；最终 message 会**替换**这个样本而不是叠加，模型名与请求头不一致时同样如此 |
| 未知模型 | 只计数、只列名，绝不定价。没有公开价格的模型贡献 token 与请求数、金额为零，卡片会明说 |
| 持久性 | 一个会话投影（`costMeter`），从日志折叠而来。翻页、压缩、刷新、重启服务都不影响，走标准投影缓存 |

## 对模型的影响

没有。`dsh-meter` 不加工具、不加系统提示、不加消息、不发模型请求，完全不碰请求本身。花费是付钱的人该看的东西，不该占 agent 的上下文。

#### KV 缓存影响

无——本插件从不参与请求。

## 配置

以下都是校验过的配置项，写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-meter
  config:
    currency: cny        # 固定价目表，不再自动识别
    balance: false       # 完全不调用 /user/balance
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `currency` | `auto` | 显示哪张价目表：`auto`（先看账号余额币种，再退到界面语言）、`usd`、`cny` |
| `balance` | `true` | 是否把账户余额提供给 Web UI |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 存放 API key 的凭据引用 |
| `baseUrl` | `https://api.deepseek.com` | 读取余额的接口来源 |
| `balanceTtlMs` | `300000` | 展开卡片时重新拉取余额的最小间隔 |
| `balanceTimeoutMs` | `4000` | 单次余额请求的超时 |

## 开发

```sh
pnpm install
pnpm test                        # 先校验产物同步，再跑 vitest
node scripts/build-client.mjs    # 改完 core/ui 后重新生成 lib/client.js
```

`lib/core.js` 是价目表、时段时钟和折叠逻辑，`lib/balance.js` 是账户读取，`src/ui.js` 是浏览器界面。`scripts/build-client.mjs` 把 core 与 ui 内联成 dsh 实际分发的 `lib/client.js`——价目表因此只存在于一个文件里，产物一旦与源码不同步 `pnpm test` 就会失败。

## 已知限制

- **这是估算，不是账单。** 官方价目乘以上报 token。优惠价格、以及任何挡在 API 前面的中转都看不到。
- **档位按发出时间戳判定**，用的是 dsh 这台机器的时钟。若 DeepSeek 实际在档位边界另一侧收到请求，可能差出一两秒。
- **非 DeepSeek 线路不定价。** 它们的 token 会被计数、模型会被列名，但卡片会标为未定价，而不是把 DeepSeek 的价格悄悄套到别人家的 API 上。
- **价目表是编译进去的。** DeepSeek 会调价；本插件带的是 2026-08-17 复核过的峰谷价目表，跟进下一次调价需要发新版本。
- **只有 Web。** 投影本身任何界面都能读，但读数是为 Web UI 做的，没有 TUI 版本。

## 参考与致谢

dsh 插件登记处已经收录了[约 50 个花费/用量插件](https://github.com/dshworks/awesome-dsh-plugins/blob/main/lists/usage-cost.md)，其中不少就出现在 DeepSeek 公布调价日期的那一周，读它们的实现影响了这一版的取舍。缓存节省的表述来自 [`deepseek-cli`](https://github.com/thevibeworks/deepseek-cli) 的本地用量账本。

## 许可

MIT

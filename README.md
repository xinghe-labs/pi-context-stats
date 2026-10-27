# context-stats

[![pi-package](https://img.shields.io/badge/pi--package-pi--context--stats-blue)](https://pi.dev/packages)

> 旧包名 `@xinghe-labs/pi-context-stats` 已废弃,统一用 `pi-context-stats`。

pi 扩展:追踪上下文压缩、prompt 缓存命中与 token 花费。**零依赖、纯 TypeScript、~420 行**。

## 状态栏

```
📦1次压缩 │ 读713.6k·本轮627.2k │ $0.059
```

| 段 | 含义 |
|---|---|
| `📦N次压缩` | 发生过 session 压缩(never compaction 时隐藏) |
| `读X·本轮Y` | X = 累计 cacheRead tokens;Y = 最近一次对话回合的 cacheRead |
| `$X.XXX` | 本会话总花费 |

## `/ctxstats` 命令

```
🧠 上下文:163.8k / 200.0k tokens(81.9%)

📦 压缩次数:2
   10:30 · 压缩前 19.4k tokens · threshold · $0.0025
   11:05 · 压缩前 320.0k tokens · overflow · $0.0040

💾 缓存读(累计):1.01M tokens
   最近一轮:300.0k │ 平均每轮:356.8k
   缓存命中率:99.6%
   缓存写:800 tokens
   其中非对话回合:压缩 19.4k · cache_warm 50.0k
♻️ 缓存浪费:51.2k tokens ≈ $0.1382(1 次 miss)

↑ 输入(未命中):3.0k tokens
↓ 输出:1.0k tokens
💬 请求次数:2
💰 总花费:$0.068
   其中:压缩 $0.0065 · cache_warm $0.0150
```

## 安装

```bash
pi install npm:pi-context-stats
```

或从本地路径:

```bash
pi install /path/to/context-stats
```

## 提醒与预警

| 时机 | 触发条件 | 行为 |
|---|---|---|
| `message_end` / `turn_end` | 会话花费 ≥ `$10`(默认) | `warning`:💰 花费达阈值(每会话一次) |
| `message_end` / `turn_end` | 上下文占用 ≥ `85%`(默认) | `warning`:🧠 占用阈值,建议提前落盘重要结论(每会话一次;压缩后重置可再触发) |
| `session_before_compact` | pi 即将压缩 | `info`:📦 准备压缩(reason · tokens · willRetry)|

阈值可在 `~/.pi/agent/settings.json` 覆写:

```json
{
  "pi-context-stats": {
    "costLimit": 5,
    "contextPercent": 70
  }
}
```

## 统计口径

### 计入的用量来源

| 来源 | 说明 |
|---|---|
| `message` (assistant) | 常规对话回合 |
| `type:"usage"` 条目 | `cache_warm` 保温刷新(pi 计入 session 总量,但不进上下文) |
| `CompactionEntry.usage` | 压缩摘要调用(走 `completeSimple`,**不触发** `message_end`) |

### 压缩原因持久化

压缩原因只存在于 live 事件(`session_compact.reason`),`CompactionEntry` 里没有。本扩展用 `pi.appendEntry("context-stats.compaction", {id, reason})` 持久化,resume/reload 后按 `entry.id` 回填。

### 缓存浪费算法

与 pi 内置 `computeCacheWaste` 数值等价(10 场景对拍验证):

- 噪声下限 **1024 tokens**(小波动不报警)
- 压缩 / 分支摘要 → **重置基准**,下一轮不误报
- 切换模型 → **仍计 miss**(会全量重算)
- `cache_warm` 保温刷新 → 被当作「上一轮请求」

### 已知差异 vs pi 内置

pi 自己的实现在 `cost` 明细缺字段时会返回 `NaN`(它写 `cost.input + cost.cacheWrite`)。本扩展用 `?? 0` 兜底,显示有限值而非 `$NaN`。代价:若 provider 真的漏报 cost 桶,数字会偏乐观(缺失桶当 0)。pi-ai 正常产出的 `Usage` 四个桶齐全,实际不会触发。

## 开发

```bash
npm test
```

运行 `test/` 下的两组测试:

- `behavior.test.mjs`:18 组 mock 行为测试(事件累计、重建、阈值、预警、时序)
- `cache-waste-crosscheck.test.mjs`:10 场景与 pi 内置 `computeCacheWaste` 对拍

测试自动探测 pi 安装目录(也可用 `PI_INSTALL_DIR` 环境变量指定),不需要 `npm install` —— 包本身零依赖,测试用的 jiti/cacache 也从 pi 自带依赖里取。

## License

MIT

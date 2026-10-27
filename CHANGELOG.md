# Changelog

All notable changes to this project will be documented in this file.

## [1.3.0] - 2026-10-27

### Added
- **测试入库**:`test/` 目录(18 组行为测试 + 10 场景与 pi 内置对拍),`npm test` 一键运行;测试自动探测 pi 安装目录(或 `PI_INSTALL_DIR`),无需装任何依赖
- **阈值可配置**:`~/.pi/agent/settings.json` 里加 `"pi-context-stats": { "costLimit": 5, "contextPercent": 70 }` 即可覆写默认阈值($10 / 85%)

### Changed
- **命中率公式修正**:分母从 `input + cacheRead + cacheWrite` 改为 `input + cacheRead` —— cacheWrite 是新写入,不是「本可命中」的缓存,不应计入分母。口径变化:同数据下命中率会略微升高(通常 <0.2%)

## [1.2.0] - 2026-10-27

### Changed
- 包名从 `@xinghe-labs/pi-context-stats` 改为无 scope 的 **`pi-context-stats`**,安装命令更短:`pi install npm:pi-context-stats`
- 旧包名已 deprecate,功能无变化

## [1.1.0] - 2026-10-27

### Added
- **预算/阈值提醒**:本会话花费达 $10 或上下文占用 ≥85% 时 `warning` 提醒一次;压缩后占用警报解除可再次触发
- **压缩前预警**(`session_before_compact`):显示 reason / 压缩前 tokens / 是否 willRetry —— 这是判断「要不要主动 /compact」的最后时机
- **turn_end 时序修正**:状态栏改为整个回合结束时刷新一次,消除一个回合多条 assistant 消息时的中间值闪烁

## [1.0.0] - 2026-10-27

### Added
- 状态栏常驻显示压缩次数 + 缓存读 + 花费
- `/ctxstats` 命令展开详情:
  - 压缩历史(时间、压缩前 tokens、原因、压缩自身花费)
  - 缓存读(累计 / 最近一轮 / 平均每轮 / 命中率 / 缓存写)
  - **上下文占用** (🧠 上下文 / 200k tokens(81.9%))
  - **缓存浪费** (♻️ tokens ≈ $金额 + miss 次数)
  - 非对话回合用量分解(cache_warm / 压缩调用)
  - 输入(未命中) / 输出 / 请求次数 / 总花费
- 压缩原因通过 `pi.appendEntry("context-stats.compaction", {id, reason})` 持久化,resume 后可回填
- 压缩历史含该次压缩自身的 LLM 调用费用
- `type:"usage"` 条目(cache_warm 保温刷新)计入统计
- 缓存浪费算法与 pi 内置 `computeCacheWaste` 数值等价(10 场景对拍验证)
- 噪声下限 1024 tokens:小幅波动不报警
- 压缩/保温后基准重置,切换模型仍计 miss

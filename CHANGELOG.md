# Changelog

All notable changes to this project will be documented in this file.

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

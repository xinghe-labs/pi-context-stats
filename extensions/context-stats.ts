/**
 * Context Stats Extension — 记录压缩次数与缓存 token 用量
 *
 * - 状态栏常驻显示:压缩次数 | 缓存读(累计/本轮) | 花费
 * - /ctxstats 查看详细统计:压缩历史、平均每轮缓存读、请求次数、非对话用量
 *   (ctxstats = context stats 的缩写)
 * - 数据从 session 分支条目重建,resume / fork 后依然准确
 *
 * 计入的不只是对话回合,还包括 pi 另外两类用量(否则总量会比 pi 自己报的少):
 * - 压缩摘要的一次性 LLM 调用:CompactionEntry.usage,走 completeSimple 直调,不触发 message_end
 * - type:"usage" 条目:如 idle 时的 prompt cache 保温刷新(kind = "cache_warm")
 *
 * 说明：cacheRead 是按请求累计的（每轮都重读整个缓存前缀），
 * 所以它 ≈ 各轮上下文大小之和，大是正常的；命中率才是省钱指标。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { computeCacheWaste } from "./cache-waste.ts";
import type { EntryLike, Stats, UsageLike } from "./types.ts";

export default function (pi: ExtensionAPI) {
	let stats: Stats = newStats();
	const STATUS_KEY = "ctx-stats";
	// 压缩原因只存在于 live 事件,条目里没有;写入自定义条目以便 resume 后回填
	const REASON_LOG = "context-stats.compaction";

	// 预算/阈值提醒:默认 $10 / 上下文 85%,各提醒一次后不再重复(新会话重置)
	// 可在 ~/.pi/agent/settings.json 里覆写:
	//   "pi-context-stats": { "costLimit": 5, "contextPercent": 70 }
	const DEFAULT_LIMITS = { cost: 10, contextPercent: 85 };

	function readLimits(): { cost: number; contextPercent: number } {
		try {
			const raw = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf-8"));
			const c = raw?.["pi-context-stats"];
			return {
				cost: typeof c?.costLimit === "number" && c.costLimit > 0 ? c.costLimit : DEFAULT_LIMITS.cost,
				contextPercent: typeof c?.contextPercent === "number" && c.contextPercent > 0 && c.contextPercent <= 100
					? c.contextPercent
					: DEFAULT_LIMITS.contextPercent,
			};
		} catch {
			return { ...DEFAULT_LIMITS };
		}
	}
	let limits = readLimits();
	let alerted = { cost: false, context: false };

	function checkThresholds(ctx: ExtensionContext): void {
		if (!ctx.hasUI || (alerted.cost && alerted.context)) return;
		if (!alerted.cost && stats.cost >= limits.cost) {
			alerted.cost = true;
			ctx.ui.notify(`💰 本会话花费已达 $${stats.cost.toFixed(2)}(阈值 $${limits.cost})`, "warning");
		}
		const cu = ctx.getContextUsage?.();
		if (!alerted.context && cu && cu.percent !== null && cu.percent >= limits.contextPercent) {
			alerted.context = true;
			ctx.ui.notify(
				`🧠 上下文占用 ${cu.percent.toFixed(0)}%(阈值 ${limits.contextPercent}%),可能即将压缩,重要结论建议先落盘到文件`,
				"warning",
			);
		}
	}

	function newStats(): Stats {
		return {
			compactions: [],
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			requests: 0,
			lastRead: 0,
			compactRead: 0,
			compactCost: 0,
			aux: new Map(),
		};
	}

	const fmt = (n: number): string => {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return `${n}`;
	};

	const fmtTime = (iso: string): string => iso.slice(11, 16); // "HH:MM"

	function hitRate(s: Stats = stats): number {
		// 分母只含本可命中的部分:cacheWrite 是新写入,不是「本可命中」的缓存
		return s.input + s.cacheRead > 0
			? (s.cacheRead / (s.input + s.cacheRead)) * 100
			: 0;
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		const dim = (t: string) => theme.fg("dim", t);
		const parts: string[] = [];

		if (stats.compactions.length > 0) {
			parts.push(theme.fg("warning", `📦${stats.compactions.length}次压缩`));
		}
		parts.push(
			dim(`读${fmt(stats.cacheRead)}·本轮${fmt(stats.lastRead)}`),
			theme.fg("success", `$${stats.cost.toFixed(3)}`),
		);
		ctx.ui.setStatus(STATUS_KEY, parts.join(dim(" │ ")));
	}

	/** 累计一次 LLM 调用。turn = 对话回合;compaction = 压缩摘要调用;aux = 非对话用量 */
	function accumulate(
		u: UsageLike | undefined,
		bucket: "turn" | "aux" | "compaction" = "turn",
	) {
		if (!u) return;
		stats.input += u.input ?? 0;
		stats.output += u.output ?? 0;
		stats.cacheRead += u.cacheRead ?? 0;
		stats.cacheWrite += u.cacheWrite ?? 0;
		stats.cost += u.cost?.total ?? 0;
		if (bucket === "turn") {
			stats.requests += 1;
			stats.lastRead = u.cacheRead ?? 0;
		} else if (bucket === "compaction") {
			stats.compactRead += u.cacheRead ?? 0;
			stats.compactCost += u.cost?.total ?? 0;
		}
	}

	/** type:"usage" 条目,如 cache_warm 保温刷新(pi 计入 session 总量,但不进模型上下文) */
	function accumulateAux(kind: string, u: UsageLike | undefined) {
		if (!u) return;
		accumulate(u, "aux");
		const prev = stats.aux.get(kind) ?? { read: 0, cost: 0, count: 0 };
		prev.read += u.cacheRead ?? 0;
		prev.cost += u.cost?.total ?? 0;
		prev.count += 1;
		stats.aux.set(kind, prev);
	}

	pi.on("session_start", async (_event, ctx) => {
		stats = newStats();
		alerted = { cost: false, context: false };
		const entries = ctx.sessionManager.getBranch();
		// 先用自定义条目建 id → reason 映射(压缩条目本身不记录原因)
		const reasons = new Map<string, string>();
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === REASON_LOG) {
				const d = entry.data as { id?: string; reason?: string } | undefined;
				if (d?.id) reasons.set(d.id, d.reason ?? "unknown");
			}
		}
		for (const entry of entries) {
			if (entry.type === "compaction") {
				const e = entry as {
					id?: string;
					tokensBefore?: number;
					timestamp?: string;
					usage?: UsageLike;
				};
				stats.compactions.push({
					time: e.timestamp ?? "",
					tokensBefore: e.tokensBefore ?? 0,
					reason: (e.id ? reasons.get(e.id) : undefined) ?? "",
					cost: e.usage?.cost?.total ?? 0,
				});
				accumulate(e.usage, "compaction");
			} else if (entry.type === "usage") {
				const e = entry as { kind?: string; usage?: UsageLike };
				accumulateAux(e.kind ?? "usage", e.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				accumulate((entry.message as { usage?: UsageLike }).usage);
			}
		}
		updateStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		const m = event.message as { role?: string; usage?: UsageLike };
		if (m.role !== "assistant") return;
		accumulate(m.usage);
		checkThresholds(ctx);
	});

	// turn_end:整个回合结束才刷新状态栏,避免一个回合多条 assistant 消息时中间值闪烁
	pi.on("turn_end", async (_event, ctx) => {
		updateStatus(ctx);
		checkThresholds(ctx);
	});

	// 压缩前预警:这是判断「要不要主动 /compact」的最后时机
	pi.on("session_before_compact", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const tokensBefore = event.preparation?.tokensBefore ?? 0;
		ctx.ui.notify(
			`📦 准备压缩(reason=${event.reason} · 压缩前 ${fmt(tokensBefore)} tokens${event.willRetry ? " · 完成后重试本轮" : ""})`,
			"info",
		);
	});

	pi.on("session_compact", async (event, ctx) => {
		const entry = event.compactionEntry as {
			id?: string;
			tokensBefore?: number;
			timestamp?: string;
			usage?: UsageLike;
		};
		const reason = event.reason ?? "manual";
		const cost = entry.usage?.cost?.total ?? 0;
		stats.compactions.push({
			time: entry.timestamp ?? "",
			tokensBefore: entry.tokensBefore ?? 0,
			reason,
			cost,
		});
		// 压缩自身的 LLM 调用走 completeSimple 直调,不触发 message_end,必须在这里记账
		accumulate(entry.usage, "compaction");
		if (entry.id) pi.appendEntry(REASON_LOG, { id: entry.id, reason });
		// 上下文被压缩重置,占用警报解除
		alerted.context = false;
		updateStatus(ctx);
		if (ctx.hasUI) {
			const costText = cost > 0 ? ` · $${cost.toFixed(4)}` : "";
			ctx.ui.notify(
				`📦 第 ${stats.compactions.length} 次压缩完成(压缩前 ${fmt(entry.tokensBefore ?? 0)} tokens${costText})`,
				"info",
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("ctxstats", {
		description: "查看压缩次数与缓存 token 统计",
		handler: async (_args, ctx) => {
			const avgRead = stats.requests > 0 ? stats.cacheRead / stats.requests : 0;
			const lines: string[] = [];

			// 当前上下文占用(估算,压缩后会短暂为 null)
			const cu = ctx.getContextUsage?.();
			if (cu && cu.tokens !== null && cu.percent !== null) {
				lines.push(
					`🧠 上下文:${fmt(cu.tokens)} / ${fmt(cu.contextWindow)} tokens(${cu.percent.toFixed(1)}%)`,
					``,
				);
			}
			// 压缩历史
			lines.push(`📦 压缩次数：${stats.compactions.length}`);
			for (const c of stats.compactions.slice(-5)) {
				const bits: string[] = [];
				if (c.time) bits.push(fmtTime(c.time));
				bits.push(`压缩前 ${fmt(c.tokensBefore)} tokens`);
				if (c.reason) bits.push(c.reason);
				if (c.cost > 0) bits.push(`$${c.cost.toFixed(4)}`);
				lines.push(`   ${bits.join(" · ")}`);
			}

			// 缓存统计
			lines.push(
				``,
				`💾 缓存读（累计）：${fmt(stats.cacheRead)} tokens`,
				`   最近一轮：${fmt(stats.lastRead)} │ 平均每轮：${fmt(avgRead)}`,
				`   缓存命中率：${hitRate().toFixed(1)}%`,
				`   缓存写:${fmt(stats.cacheWrite)} tokens`,
			);

			// 非对话回合的用量(压缩 + type:"usage" 条目)已含在累计里,这里单独列出
			const readBits: string[] = [];
			if (stats.compactRead > 0) readBits.push(`压缩 ${fmt(stats.compactRead)}`);
			for (const [kind, v] of stats.aux) {
				if (v.read > 0) readBits.push(`${kind} ${fmt(v.read)}`);
			}
			if (readBits.length > 0) {
				lines.push(`   其中非对话回合:${readBits.join(" · ")}`);
			}

			// 缓存浪费:与本会话「被重复计费」的 token / 金额(按分支条目现场重算)
			const waste = computeCacheWaste(
				ctx.sessionManager.getBranch() as EntryLike[],
				ctx.modelRegistry,
			);
			lines.push(
				waste.missCount > 0
					? `♻️ 缓存浪费:${fmt(waste.missedTokens)} tokens ≈ $${waste.missedCost.toFixed(4)}(${waste.missCount} 次 miss)`
					: `♻️ 缓存浪费:未检测到重复计费`,
			);

			// 输入输出
			lines.push(
				``,
				`↑ 输入（未命中）：${fmt(stats.input)} tokens`,
				`↓ 输出：${fmt(stats.output)} tokens`,
				`💬 请求次数：${stats.requests}`,
				`💰 总花费:$${stats.cost.toFixed(4)}`,
			);

			const costBits: string[] = [];
			if (stats.compactCost > 0) costBits.push(`压缩 $${stats.compactCost.toFixed(4)}`);
			for (const [kind, v] of stats.aux) {
				if (v.cost > 0) costBits.push(`${kind} $${v.cost.toFixed(4)}`);
			}
			if (costBits.length > 0) {
				lines.push(`   其中:${costBits.join(" · ")}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

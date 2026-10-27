/**
 * Context Stats Extension — 记录压缩次数与缓存 token 用量
 *
 * - 状态栏常驻显示:压缩次数 | 缓存读(累计/本轮) | 花费
 * - /ctxstats 查看详细统计:压缩历史、平均每轮缓存读、请求次数、非对话用量
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

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

/** 非对话回合的用量,按 kind 分组(如 cache_warm) */
interface AuxUsage {
	read: number;
	cost: number;
	count: number;
}

interface CompactionRecord {
	time: string;
	tokensBefore: number;
	reason: string;
	cost: number;
}

interface Stats {
	compactions: CompactionRecord[];
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	requests: number;
	lastRead: number; // 最近一次对话回合的缓存读
	compactRead: number; // 压缩调用自身的缓存读(已计入 cacheRead)
	compactCost: number;
	aux: Map<string, AuxUsage>; // type:"usage" 条目(已计入上面的总量)
}

/** pi 判定缓存 miss 的噪声下限。复刻自 pi 内置 dist/core/cache-stats.js */
const NOISE_FLOOR_TOKENS = 1024;

interface CacheWaste {
	missedTokens: number;
	missedCost: number;
	missCount: number;
}

interface RequestState {
	promptTokens: number;
	reportedCache: boolean;
}

interface ModelRegistryLike {
	find(provider: string, modelId: string):
		| { cost: { cacheRead: number } }
		| undefined;
}

/** 用于扫描分支条目的宽类型(条目种类多,只取需要的字段) */
interface EntryLike {
	type?: string;
	kind?: string;
	usage?: UsageLike;
	message?: {
		role?: string;
		provider?: string;
		model?: string;
		usage?: UsageLike;
	};
}

function asPreviousRequest(
	u: UsageLike | undefined,
	reportedCache: boolean,
): RequestState | undefined {
	if (!u) return undefined;
	const promptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
	if (promptTokens <= 0) return undefined;
	return {
		promptTokens,
		reportedCache: reportedCache || u.cacheRead + u.cacheWrite > 0,
	};
}

/**
 * 缓存浪费:上一轮 prompt 里本来已在缓存中的 token,这一轮却被按 input / cacheWrite 重新计费。
 * 它比命中率更能说明「到底花了多少冤枉钱」。算法与 pi 内置的 computeCacheWaste 一致
 * (内的 cache-stats.js 未公开导出,且本目录解析不到包内深层路径,故在此复刻)。
 */
function computeCacheWaste(
	entries: readonly EntryLike[],
	registry: ModelRegistryLike | undefined,
): CacheWaste {
	const totals: CacheWaste = { missedTokens: 0, missedCost: 0, missCount: 0 };
	let prev: RequestState | undefined;

	for (const entry of entries) {
		// 上下文被合法改写(压缩/分支摘要),下一轮 prompt 是新内容,不算浪费;模型切换除外(会重新全量计费)
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			prev = undefined;
			continue;
		}
		// 保温刷新本身被视为「上一轮请求」,不作为 miss 源
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			prev = asPreviousRequest(entry.usage, true) ?? prev;
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;

		const msg = entry.message;
		const u = msg.usage;
		const promptTokens = u
			? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
			: 0;
		// 首次请求、无缓存活动上报(provider 不支持缓存)都不算 miss
		const eligible =
			prev !== undefined &&
			u !== undefined &&
			promptTokens > 0 &&
			(u.cacheRead + u.cacheWrite > 0 || prev.reportedCache);
		if (eligible && prev && u) {
			const missedTokens = Math.min(prev.promptTokens, promptTokens) - u.cacheRead;
			if (missedTokens > NOISE_FLOOR_TOKENS) {
				// 被重新计费的部分只能落在 input / cacheWrite 桶,所以实付单价直接由本条消息的成本明细得出
				const paidTokens = u.input + u.cacheWrite;
				const paidPerToken =
					paidTokens > 0
						? ((u.cost?.input ?? 0) + (u.cost?.cacheWrite ?? 0)) / paidTokens
						: 0;
				const readPerToken =
					u.cacheRead > 0
						? (u.cost?.cacheRead ?? 0) / u.cacheRead
						: msg.provider && msg.model
							? (registry?.find(msg.provider, msg.model)?.cost.cacheRead ?? 0) / 1_000_000
							: 0;
				totals.missedTokens += missedTokens;
				totals.missedCost += missedTokens * Math.max(0, paidPerToken - readPerToken);
				totals.missCount += 1;
			}
		}
		prev = asPreviousRequest(u, prev?.reportedCache ?? false) ?? prev;
	}
	return totals;
}

export default function (pi: ExtensionAPI) {
	let stats: Stats = newStats();
	const STATUS_KEY = "ctx-stats";
	// 压缩原因只存在于 live 事件,条目里没有;写入自定义条目以便 resume 后回填
	const REASON_LOG = "context-stats.compaction";

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
		updateStatus(ctx);
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

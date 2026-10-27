/**
 * 缓存浪费计算 —— 纯算法,无 pi 依赖,可独立测试。
 *
 * 缓存浪费:上一轮 prompt 里本来已在缓存中的 token,这一轮却被按 input / cacheWrite 重新计费。
 * 它比命中率更能说明「到底花了多少冤枉钱」。算法与 pi 内置的 computeCacheWaste 一致
 * (pi 的 cache-stats.js 未公开导出,且本目录解析不到包内深层路径,故在此复刻)。
 */

import type {
	CacheWaste,
	EntryLike,
	ModelRegistryLike,
	RequestState,
	UsageLike,
} from "./types.ts";

/** pi 判定缓存 miss 的噪声下限。复刻自 pi 内置 dist/core/cache-stats.js */
export const NOISE_FLOOR_TOKENS = 1024;

export function asPreviousRequest(
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

export function computeCacheWaste(
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

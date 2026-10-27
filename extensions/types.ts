/** 共享类型。数据聚合与算法(cache-waste.ts)和事件接线(context-stats.ts)都依赖这里。 */

export interface UsageLike {
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
export interface AuxUsage {
	read: number;
	cost: number;
	count: number;
}

export interface CompactionRecord {
	time: string;
	tokensBefore: number;
	reason: string;
	cost: number;
}

export interface Stats {
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

export interface CacheWaste {
	missedTokens: number;
	missedCost: number;
	missCount: number;
}

export interface RequestState {
	promptTokens: number;
	reportedCache: boolean;
}

export interface ModelRegistryLike {
	find(provider: string, modelId: string):
		| { cost: { cacheRead: number } }
		| undefined;
}

/** 用于扫描分支条目的宽类型(条目种类多,只取需要的字段) */
export interface EntryLike {
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

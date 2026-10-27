// mock 测试:验证 context-stats.ts 运行时行为(纯 Node,无需安装任何依赖)
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// pi 安装根探测:优先 PI_INSTALL_DIR 环境变量,否则从本文件位置向上找
function findPiRoot() {
	if (process.env.PI_INSTALL_DIR && existsSync(process.env.PI_INSTALL_DIR)) return process.env.PI_INSTALL_DIR;
	let dir = dirname(dirname(fileURLToPath(import.meta.url))); // 包根
	for (let i = 0; i < 4; i++) {
		for (const rel of [
			"install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent",
			"install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent",
		]) {
			const candidate = join(dir, rel);
			if (existsSync(candidate)) return candidate;
		}
		dir = dirname(dir);
	}
	throw new Error("找不到 pi 安装目录,请设置 PI_INSTALL_DIR");
}
const PI = findPiRoot();
// jiti 从 pi 自带依赖里取(包本身零依赖,只有测试需要)
// jiti 是 pi 的传递依赖,装在其 node_modules 根(pi-coding-agent 包内没有)
const JitiRoot = PI.replace(/\/node_modules\/@earendil-works\/pi-coding-agent$/, "");
const { createJiti } = await import(new URL("jiti/lib/jiti.mjs", `file://${JitiRoot}/node_modules/`).href);
const jiti = createJiti(import.meta.url);

const mod = await jiti.import(new URL("../extensions/context-stats.ts", import.meta.url).href);

const handlers = {};
const commands = {};
const appended = [];
const pi = {
	on: (name, h) => { handlers[name] = h; },
	registerCommand: (name, cmd) => { commands[name] = cmd; },
	appendEntry: (customType, data) => { appended.push({ customType, data }); },
};
mod.default(pi);

let statusText = null;
let notifications = [];
const usage = (input, output, cacheRead, cacheWrite, total, breakdown) => ({
	input, output, cacheRead, cacheWrite,
	cost: { total, ...(breakdown ?? {}) },
});
const assistantMsg = (u, provider = "p", model = "m") => ({
	type: "message", message: { role: "assistant", provider, model, usage: u },
});
const warmEntry = (u) => ({ type: "usage", kind: "cache_warm", provider: "p", model: "m", usage: u });
const compactEntry = (id, tokensBefore, timestamp, u) => ({
	type: "compaction", id, tokensBefore, timestamp, usage: u,
});
const reasonEntry = (id, reason) => ({
	type: "custom", customType: "context-stats.compaction", data: { id, reason },
});

let branch = [
	assistantMsg(usage(1800, 600, 17000, 800, 0.03, { input: 0.0054, output: 0.009, cacheRead: 0.0051, cacheWrite: 0.003 })),
	warmEntry(usage(0, 0, 50000, 0, 0.015)),
	compactEntry("c1", 19400, "2026-02-05T10:30:00.000Z", usage(0, 0, 19400, 0, 0.0025)),
	reasonEntry("c1", "threshold"),
	assistantMsg(usage(1200, 400, 627200, 0, 0.012, { input: 0.0036, output: 0.006, cacheRead: 0.18816, cacheWrite: 0 })),
];

const makeCtx = (hasUI = true) => ({
	hasUI,
	ui: { theme: { fg: (_c, t) => t }, setStatus: (_k, text) => { statusText = text; }, notify: (msg) => notifications.push(msg) },
	sessionManager: { getBranch: () => branch },
	modelRegistry: { find: () => ({ cost: { cacheRead: 0.3 } }) },
	getContextUsage: () => ({ tokens: 163840, contextWindow: 200000, percent: 81.9 }),
});

const ctx = makeCtx();
const T = (cond, msg) => { if (!cond) throw new Error("FAIL: " + msg); };
const inOut = (needle, where = notifications.join("\n")) =>
	T(where.includes(needle), `缺少「${needle}」\n--- 实际输出 ---\n${where}`);

// ── 1. session_start 重建(含压缩 + cache_warm 漏计用量)
await handlers["session_start"]({ reason: "resume" }, ctx);
console.log("状态栏:", statusText);
T(/📦1次压缩/.test(statusText), "压缩次数应为 1:" + statusText);
T(/读713\.6k/.test(statusText), "累计缓存读应为 713.6k:" + statusText);
T(/本轮627\.2k/.test(statusText), "本轮应显示最近的对话回合 627.2k:" + statusText);
T(/\$0\.059/.test(statusText), "总花费应为 $0.059:" + statusText);
T(!/命中|↑|↓/.test(statusText), "状态栏不应含命中率/输入输出:" + statusText);
console.log("✓ session_start:两类漏计用量已并入总量,状态栏格式正确");

// ── 2. /ctxstats 详情(含上下文占用 + 新增功能)
await commands["ctxstats"].handler("", ctx);
console.log("---- /ctxstats ----\n" + notifications.join("\n") + "\n-------------------");
inOut("🧠 上下文:163.8k / 200.0k tokens(81.9%)");
inOut("压缩次数：1");
inOut("10:30");
inOut("压缩前 19.4k tokens");
inOut("threshold");
inOut("$0.0025");
inOut("其中非对话回合:压缩 19.4k · cache_warm 50.0k");
inOut("其中:压缩 $0.0025 · cache_warm $0.0150");
inOut("请求次数：2");
inOut("平均每轮：356.8k");
console.log("✓ /ctxstats:上下文占用已显示,压缩历史含原因+花费,非对话用量分解正确");

// ── 3. message_end 只累计数据,不再刷状态栏(时序修正后由 turn_end 一次刷新)
notifications = [];
await handlers["message_end"](
	{ message: { role: "assistant", usage: usage(900, 500, 300000, 1200, 0.008, { input: 0.0027, output: 0.0075, cacheRead: 0.09, cacheWrite: 0.0045 }) } }, ctx,
);
T(/读713\.6k/.test(statusText), "message_end 后状态栏应保持旧值(等 turn_end):" + statusText);
await handlers["turn_end"](
	{ type: "turn_end", turnIndex: 0, message: {}, toolResults: [], messageEntryId: "", toolResultEntryIds: [] }, ctx,
);
T(/读1\.01M/.test(statusText), "turn_end 后应增至 1.01M:" + statusText);
T(/本轮300\.0k/.test(statusText), "本轮应更新为 300.0k:" + statusText);
console.log("✓ message_end 累计 + turn_end 刷新:", statusText);

// ── 4. session_compact + 原因持久化
statusText = null; notifications = [];
await handlers["session_compact"]({
	compactionEntry: compactEntry("c2", 320000, "2026-02-05T11:05:00.000Z", usage(0, 0, 320000, 0, 0.004)),
	fromExtension: false, reason: "overflow", willRetry: false,
}, ctx);
T(/📦2次压缩/.test(statusText), "压缩次数应为 2:" + statusText);
T(appended.length === 1 && appended[0].customType === "context-stats.compaction"
	&& appended[0].data.id === "c2" && appended[0].data.reason === "overflow",
	"应 appendEntry 持久化 {id:c2, reason:overflow},实际: " + JSON.stringify(appended));
T(/第 2 次压缩完成/.test(notifications[0]), "压缩通知不符: " + notifications[0]);
T(/320\.0k tokens · \$0\.0040/.test(notifications[0]), "通知应含压缩前 tokens 与花费: " + notifications[0]);
console.log("✓ session_compact:压缩开销并入总量,原因已持久化 ->", notifications[0]);

// ── 5. 模拟 reload:两条压缩记录的原因与花费均可恢复
branch = [
	assistantMsg(usage(1800, 600, 17000, 800, 0.03, { input: 0.0054, output: 0.009, cacheRead: 0.0051, cacheWrite: 0.003 })),
	compactEntry("c1", 19400, "2026-02-05T10:30:00.000Z", usage(0, 0, 19400, 0, 0.0025)),
	reasonEntry("c1", "threshold"),
	assistantMsg(usage(900, 500, 300000, 1200, 0.008, { input: 0.0027, output: 0.0075, cacheRead: 0.09, cacheWrite: 0.0045 })),
	compactEntry("c2", 320000, "2026-02-05T11:05:00.000Z", usage(0, 0, 320000, 0, 0.004)),
	reasonEntry("c2", "overflow"),
];
notifications = [];
await handlers["session_start"]({ reason: "reload" }, ctx);
await commands["ctxstats"].handler("", ctx);
inOut("10:30");
inOut("11:05");
inOut("threshold");
inOut("overflow");
inOut("压缩次数：2");
console.log("✓ reload 重建:两条压缩记录的原因与花费均可恢复");

// ── 6. 旧 session 兼容(无原因条目/无 usage)
branch = [
	compactEntry("old1", 120000, "2026-02-05T09:00:00.000Z", undefined),
	assistantMsg(usage(100, 50, 1000, 0, 0.001, { input: 0.0003, output: 0.00075, cacheRead: 0.0003, cacheWrite: 0 })),
];
notifications = [];
await handlers["session_start"]({ reason: "resume" }, ctx);
await commands["ctxstats"].handler("", ctx);
inOut("09:00");
inOut("压缩前 120.0k tokens");
T(!notifications.join("\n").includes("undefined"), "不应出现 undefined");
T(!notifications.join("\n").includes("NaN"), "不应出现 NaN");
console.log("✓ 旧 session(无原因/无 usage 条目)兼容,不报错不显示 undefined");

// ── 7. 缓存浪费:完全 miss
branch = [
	assistantMsg(usage(200, 100, 50000, 1000, 0.0115, { input: 0.0006, output: 0.0015, cacheRead: 0.0075, cacheWrite: 0.001875 })),
	assistantMsg(usage(52000, 200, 0, 0, 0.159, { input: 0.156, output: 0.003 })),
];
notifications = [];
await handlers["session_start"]({ reason: "resume" }, ctx);
await commands["ctxstats"].handler("", ctx);
inOut("♻️ 缓存浪费:51.2k tokens ≈ $0.1382(1 次 miss)");
console.log("✓ 缓存浪费:51200 tokens 完全 miss 被识别 ≈ $0.1382");

// ── 8. 缓存浪费:命中良好,被噪声下限过滤
branch = [
	assistantMsg(usage(200, 100, 50000, 1000, 0.0115, { input: 0.0006, output: 0.0015, cacheRead: 0.0075, cacheWrite: 0.001875 })),
	assistantMsg(usage(100, 100, 50500, 500, 0.012, { input: 0.0003, output: 0.0015, cacheRead: 0.007575, cacheWrite: 0.0009375 })),
];
notifications = [];
await handlers["session_start"]({ reason: "resume" }, ctx);
await commands["ctxstats"].handler("", ctx);
inOut("♻️ 缓存浪费:未检测到重复计费");
console.log("✓ 缓存浪费:命中良好的小幅波动被噪声下限过滤");

// ── 9. 缓存浪费:压缩后不误报
branch = [
	assistantMsg(usage(200, 100, 50000, 1000, 0.0115, { input: 0.0006, output: 0.0015, cacheRead: 0.0075, cacheWrite: 0.001875 })),
	{ type: "compaction", id: "cc", tokensBefore: 51200, timestamp: "2026-02-05T13:00:00.000Z", usage: undefined },
	assistantMsg(usage(3000, 100, 0, 0, 0.009, { input: 0.009 })),
];
notifications = [];
await handlers["session_start"]({ reason: "resume" }, ctx);
await commands["ctxstats"].handler("", ctx);
inOut("♻️ 缓存浪费:未检测到重复计费");
console.log("✓ 缓存浪费:压缩后不误报");

// ── 10. shutdown / hasUI=false / 新会话
notifications = [];
await handlers["session_shutdown"]({}, ctx);
T(statusText === undefined, "shutdown 应清除状态栏:" + statusText);
const noUi = makeCtx(false);
await handlers["session_start"]({ reason: "startup" }, noUi);
await handlers["session_compact"]({
	compactionEntry: compactEntry("c9", 100, "2026-02-05T12:00:00.000Z", undefined),
	reason: "manual",
}, noUi);
await commands["ctxstats"].handler("", noUi);
console.log("✓ shutdown 清理 + hasUI=false 全程不崩溃");

branch = [];
await handlers["session_start"]({ reason: "new" }, ctx);
T(/读0·本轮0/.test(statusText), "新会话应从零开始:" + statusText);
console.log("✓ 新会话从零开始:", statusText);

// ── 11. 预算阈值:花费 ≥ $10 触发一次,之后不重复
branch = [];
notifications = [];
await handlers["session_start"]({ reason: "startup" }, ctx);
await handlers["message_end"](
	{ message: { role: "assistant", usage: usage(1000, 500, 1000, 0, 10.5, { input: 10.5 }) } }, ctx,
);
T(notifications.some((n) => n.includes("💰 本会话花费已达 $10.50")), "应触发花费警报:" + JSON.stringify(notifications));
notifications = [];
await handlers["message_end"](
	{ message: { role: "assistant", usage: usage(100, 50, 100, 0, 2, { input: 2 }) } }, ctx,
);
T(!notifications.some((n) => n.includes("💰")), "同一会话不应重复触发:" + JSON.stringify(notifications));
console.log("✓ 预算阈值:达 $10 触发一次,后续不重复");

// ── 12. 上下文占用阈值:≥85% 触发;压缩后警报解除可再触发
notifications = [];
ctx.getContextUsage = () => ({ tokens: 180000, contextWindow: 200000, percent: 90 });
await handlers["turn_end"](
	{ type: "turn_end", turnIndex: 0, message: {}, toolResults: [], messageEntryId: "", toolResultEntryIds: [] }, ctx,
);
T(notifications.some((n) => n.includes("🧠 上下文占用 90%")), "应触发上下文警报:" + JSON.stringify(notifications));
notifications = [];
await handlers["turn_end"](
	{ type: "turn_end", turnIndex: 1, message: {}, toolResults: [], messageEntryId: "", toolResultEntryIds: [] }, ctx,
);
T(!notifications.some((n) => n.includes("🧠")), "占用警报不重复:" + JSON.stringify(notifications));
await handlers["session_compact"]({
	compactionEntry: compactEntry("ct", 180000, "2026-02-05T14:00:00.000Z", undefined),
	reason: "threshold",
}, ctx);
notifications = [];
await handlers["turn_end"](
	{ type: "turn_end", turnIndex: 2, message: {}, toolResults: [], messageEntryId: "", toolResultEntryIds: [] }, ctx,
);
T(notifications.some((n) => n.includes("🧠 上下文占用 90%")), "压缩后警报应重新可触发:" + JSON.stringify(notifications));
console.log("✓ 上下文占用阈值:≥85% 触发,压缩后警报解除可再触发");

// ── 13. 压缩前预警(session_before_compact)
notifications = [];
await handlers["session_before_compact"]({
	type: "session_before_compact",
	preparation: { tokensBefore: 180000, firstKeptEntryId: "", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, fileOps: {}, settings: {} },
	branchEntries: [], reason: "threshold", willRetry: true, signal: undefined,
}, ctx);
T(notifications.some((n) => n.includes("📦 准备压缩(reason=threshold · 压缩前 180.0k tokens · 完成后重试本轮)")),
	"应预警准备压缩:" + JSON.stringify(notifications));
console.log("✓ 压缩前预警:reason/tokens/willRetry 均正确展示");

// ── 14. turn_end 时序:turn_end 后才刷状态栏,message_end 不再刷
branch = [];
notifications = [];
await handlers["session_start"]({ reason: "new" }, ctx);
const t0 = statusText;
await handlers["message_end"](
	{ message: { role: "assistant", usage: usage(100, 50, 1000, 0, 0.001, { input: 0.0003, output: 0.00075, cacheRead: 0.0003, cacheWrite: 0 }) } }, ctx,
);
T(statusText === t0, "message_end 不应再刷新状态栏(等 turn_end):" + statusText);
await handlers["turn_end"](
	{ type: "turn_end", turnIndex: 0, message: {}, toolResults: [], messageEntryId: "", toolResultEntryIds: [] }, ctx,
);
T(/读1\.0k/.test(statusText), "turn_end 后状态栏应更新:" + statusText);
console.log("✓ turn_end 时序:中间态不再闪烁,回合结束时一次刷新");

console.log("\n全部测试通过 ✔");
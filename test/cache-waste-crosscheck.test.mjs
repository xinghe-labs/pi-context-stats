// 对拍:复刻的 computeCacheWaste 与 pi 内置实现数值等价(纯 Node,无需安装任何依赖)
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
// jiti 与 pi 内置 cache-stats 都从 pi 自带依赖里取(包本身零依赖,只有测试需要)
// jiti 是 pi 的传递依赖,装在其 node_modules 根(pi-coding-agent 包内没有)
const JitiRoot = PI.replace(/\/node_modules\/@earendil-works\/pi-coding-agent$/, "");
const { createJiti } = await import(new URL("jiti/lib/jiti.mjs", `file://${JitiRoot}/node_modules/`).href);
const jiti = createJiti(import.meta.url);

const { computeCacheWaste: piWaste } = await import(new URL("dist/core/cache-stats.js", `file://${PI}/`).href);
const mod = await jiti.import(new URL("../extensions/context-stats.ts", import.meta.url).href);

const handlers = {}, commands = {};
mod.default({ on: (n, h) => { handlers[n] = h; }, registerCommand: (n, c) => { commands[n] = c; }, appendEntry: () => {} });

const P = { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 };
const piModels = { getModel: () => ({ cost: { cacheRead: P.cacheRead } }) };

let notifications = [];
const u = (input, output, cacheRead, cacheWrite) => {
	const cost = {
		input: (input * P.input) / 1e6, output: (output * P.output) / 1e6,
		cacheRead: (cacheRead * P.cacheRead) / 1e6, cacheWrite: (cacheWrite * P.cacheWrite) / 1e6,
	};
	return { input, output, cacheRead, cacheWrite, cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite } };
};
const msg = (usage, ts = 1, provider = "p", model = "m") => ({
	type: "message", message: { role: "assistant", provider, model, timestamp: ts, usage },
});
const warm = (usage) => ({ type: "usage", kind: "cache_warm", provider: "p", model: "m", timestamp: "2026-02-05T10:00:00.000Z", usage });
const compact = () => ({ type: "compaction", id: "c1", tokensBefore: 100, timestamp: "2026-02-05T10:00:00.000Z" });

const ctx = {
	hasUI: true,
	ui: { theme: { fg: (_c, t) => t }, setStatus: () => {}, notify: (m) => notifications.push(m) },
	getContextUsage: () => ({ tokens: 163840, contextWindow: 200000, percent: 81.9 }),
};

// 10 场景
const scenarios = {
	"完全 miss": [msg(u(200, 100, 50000, 1000), 100), msg(u(52000, 200, 0, 0), 200)],
	"命中良好 → 噪声下限过滤": [msg(u(200, 100, 50000, 1000), 100), msg(u(100, 100, 50500, 500), 200)],
	"压缩后重置基准": [msg(u(200, 100, 50000, 1000), 100), compact(), msg(u(3000, 100, 0, 0), 200)],
	"保温刷新作为上一轮 → miss": [msg(u(200, 100, 50000, 1000), 100), warm(u(0, 0, 51200, 0)), msg(u(52000, 200, 0, 0), 200)],
	"仅首轮(无前序)": [msg(u(3000, 100, 0, 0), 200)],
	"provider 从不报缓存 → 不误报": [msg(u(3000, 100, 0, 0), 100), msg(u(3000, 100, 0, 0), 200)],
	"连续两次 miss": [msg(u(200, 100, 50000, 1000), 100), msg(u(52000, 200, 0, 0), 200), msg(u(52000, 200, 0, 0), 300)],
	"上下文增长 → 部分 miss": [msg(u(200, 100, 50000, 1000), 100), msg(u(20000, 200, 30000, 0), 200)],
	"切换模型 → 仍计 miss": [msg(u(200, 100, 50000, 1000), 100), msg(u(52000, 200, 0, 0), 200, "p2", "m2")],
	"缩小 prompt → 取 min": [msg(u(100, 50, 100000, 0), 100), msg(u(50, 50, 1000, 0), 200)],
};

const parseWaste = (text) => {
	const m = /♻️ 缓存浪费:(\S+) tokens ≈ \$([\d.]+)\((\d+) 次 miss\)/.exec(text);
	if (!m) return text.includes("未检测到重复计费") ? { tokens: 0, cost: 0, count: 0 } : null;
	const raw = m[1];
	const tokens = raw.endsWith("M") ? parseFloat(raw) * 1e6 : raw.endsWith("k") ? parseFloat(raw) * 1e3 : parseFloat(raw);
	return { tokens, cost: parseFloat(m[2]), count: parseInt(m[3], 10) };
};

const close = (a, b, tol) => typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

let failures = 0;
for (const [name, branch] of Object.entries(scenarios)) {
	const real = piWaste(branch, piModels);
	notifications = [];
	ctx.sessionManager = { getBranch: () => branch };
	ctx.modelRegistry = { find: () => ({ cost: { cacheRead: P.cacheRead } }) };
	await handlers["session_start"]({ reason: "resume" }, ctx);
	await commands["ctxstats"].handler("", ctx);
	const mine = parseWaste(notifications.join("\n"));
	const bad = [
		["miss 次数", mine?.count, real.missCount, 0],
		["浪费 tokens", mine?.tokens, real.missedTokens, Math.max(1, real.missedTokens * 0.001)],
		["浪费金额", mine?.cost, real.missedCost, 1e-4],
	].filter(([, g, w, t]) => !close(g, w, t));
	if (bad.length > 0) {
		failures++;
		console.log(`✗ ${name}`);
		bad.forEach(([l, g, w, t]) => console.log(`    ${l}: 我的=${g} pi=${w}`));
	} else {
		console.log(`✓ ${name}  →  ${real.missCount}次 / ${real.missedTokens} tokens / $${real.missedCost.toFixed(6)}`);
	}
}

console.log(failures === 0
	? "\n对拍全部一致 ✔ (完好 Usage 上与 pi 内置 computeCacheWaste 数值等价)"
	: `\n${failures} 个场景不一致 ✗`);
process.exit(failures === 0 ? 0 : 1);
#!/usr/bin/env node
/**
 * 每天早上一段毛选（推送脚本）
 * ============================
 * 取哪一条：index = (上海今天 - startDate)的天数 % 条目数
 *   · 不存状态、不用数据库，纯计算
 *   · 50 天一轮，第 51 天自动回到第 1 条
 *
 * 用法：
 *   node daily-quote.mjs --dry                 只看今天该发什么（不发送）
 *   node daily-quote.mjs --dry --day 3         看第 3 条（从 1 开始数）
 *   node daily-quote.mjs --dry --at "2026-10-25 07:00"  模拟某天
 *   node daily-quote.mjs --notify              真发（需要 PUSHPLUS_TOKEN）
 *
 * 环境变量：PUSHPLUS_TOKEN（必填）、DRY_RUN=1（不真发）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(HERE, "quotes.json");
const PUSHPLUS_ENDPOINT = "https://www.pushplus.plus/send";
const OFFSET_MINUTES = 8 * 60; // 中国固定 UTC+8

const pad = (value) => String(value).padStart(2, "0");

/** 上海时间的 yyyy-mm-dd（不依赖运行环境时区）。 */
export function shanghaiDate(date = new Date()) {
  const shifted = new Date(date.getTime() + OFFSET_MINUTES * 60000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** 两个 yyyy-mm-dd 之间相差的天数。 */
export function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

/** 今天该第几条（0 基）。还没到开始日期时固定回第 1 条。 */
export function indexFor(data, date = new Date()) {
  const offset = daysBetween(data.startDate, shanghaiDate(date));
  const total = data.items.length;
  if (offset < 0) return 0;
  return offset % total;
}

/** 渲染成一段可以直接看的文本。 */
export function render(data, item, index) {
  const dayNumber = index + 1;
  return [
    `📖 ${data.title} · 第 ${dayNumber} 天`,
    `《${item.title}》（${item.date}）`,
    "",
    `「${item.quote}」`,
    "",
    "—— 原文 ——",
    item.excerpt,
    "",
    "—— 当时 ——",
    item.context,
    "",
    "—— 想一想 ——",
    item.thought,
  ].join("\n");
}

/**
 * 推送标题。
 * 为什么要把名句塞进标题：PushPlus 走微信服务号时**默认只显示标题**，
 * 正文要点链接才能看到（见 pushplus 文档「如何在公众号中显示推送内容」）。
 * 标题上限 100 字，这里控制在 60 字以内，免得在通知栏被截断。
 *
 * 名句过长时**优先在句末标点处断开**，避免出现「…，"是"就是客观事物的内部联系，…」
 * 这种读着断气的情况。
 */
export function renderTitle(item) {
  const clean = String(item.quote ?? "").replace(/^[「『]|[」』]$/gu, "");
  const tail = `—《${item.title}》`;
  const budget = 60 - tail.length - 2;
  let quote = clean;

  if (quote.length > budget) {
    // 在预算范围内找**最后一个**标点：太靠前切会只剩半句（"马克思主义者不是算命先生，"）
    const lastWithin = (marks) => {
      let found = -1;
      const limit = Math.min(quote.length, budget);
      for (let i = 0; i < limit; i += 1) {
        if (marks.includes(quote[i])) found = i;
      }
      return found;
    };
    const sentence = lastWithin("。！？");
    if (sentence >= 12) {
      quote = quote.slice(0, sentence + 1);
    } else {
      const clause = lastWithin("；，、");
      // 在逗号处断开时用省略号收尾，读起来才不像断句
      quote = clause >= 12 ? `${quote.slice(0, clause)}…` : `${quote.slice(0, Math.max(4, budget - 1))}…`;
    }
  }

  return `「${quote}」${tail}`;
}

/** 极简 HTTPS POST（兼容老 Node，不依赖全局 fetch）。 */
function httpsPost(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = Buffer.from(payload, "utf8");
    const request = httpsRequest(
      {
        hostname: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        method: "POST",
        headers: { "Content-Length": body.length, ...headers },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, body: text.slice(0, 300) }));
      },
    );
    request.on("error", reject);
    request.setTimeout(15000, () => request.destroy(new Error("请求超时")));
    request.write(body);
    request.end();
  });
}

export async function push(token, title, content) {
  if (process.env.DRY_RUN === "1") {
    return { status: 200, body: '{"code":200,"msg":"dry-run（没有真的发）"}' };
  }
  return httpsPost(
    PUSHPLUS_ENDPOINT,
    { "Content-Type": "application/json; charset=utf-8" },
    JSON.stringify({ token, title, content, template: "txt" }),
  );
}

/* ------------------------------------------------------------ 命令行 */

function parseArgs(argv) {
  const args = { notify: false, dry: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--notify") args.notify = true;
    else if (item === "--dry") args.dry = true;
    else if (item === "--day") args.day = Number(argv[++index]);
    else if (item === "--at") args.at = argv[++index];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(readFileSync(DATA_PATH, "utf8").replace(/^\uFEFF/u, ""));
  if (!Array.isArray(data.items) || data.items.length === 0) throw new Error("quotes.json 里没有条目");
  if (!data.startDate) throw new Error("quotes.json 缺少 startDate");

  const now = args.at ? new Date(`${args.at.replace(" ", "T")}:00+08:00`) : new Date();
  const index = Number.isFinite(args.day) && args.day > 0 ? args.day - 1 : indexFor(data, now);
  const item = data.items[index % data.items.length];
  if (!item) throw new Error(`找不到第 ${index + 1} 条`);

  const text = render(data, item, index % data.items.length);
  const chars = text.replace(/\s/gu, "").length;

  console.log(`日期：${shanghaiDate(now)}｜第 ${(index % data.items.length) + 1} / ${data.items.length} 条｜${chars} 字（不含空白）｜${item.verified ? "已核对" : "⚠️ 未核对"}`);
  console.log(`推送标题（微信通知栏只能看到这个，${renderTitle(item).length} 字）：${renderTitle(item)}`);
  console.log("─".repeat(60));
  console.log(text);
  console.log("─".repeat(60));

  if (args.dry || !args.notify) {
    if (!args.dry) console.log("\n（预演模式：加 --notify 才会真的推送）");
    return;
  }

  const token = process.env.PUSHPLUS_TOKEN ?? "";
  if (!token) {
    console.error("缺少环境变量 PUSHPLUS_TOKEN");
    process.exitCode = 1;
    return;
  }
  const result = await push(token, renderTitle(item), text);
  console.log(`\n推送结果：HTTP ${result.status}｜${result.body}`);
  if (result.status !== 200) process.exitCode = 1;
}

if (process.argv[1]) {
  // 用 pathToFileURL 判断是否被直接运行：手写 "file://" + 路径在 Windows 上会拼错。
  const { pathToFileURL } = await import("node:url");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
}

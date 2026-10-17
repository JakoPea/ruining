#!/usr/bin/env node
/**
 * 通用「每日一读」推送引擎（原则 / 史记）
 * =====================================
 * 和毛选的 daily-quote.mjs 分开，互不影响。
 *
 * 用法：
 *   node daily-push.mjs --topic principles --dry        # 预演今天该发什么
 *   node daily-push.mjs --topic shiji --dry --day 7     # 预演第 7 条
 *   node daily-push.mjs --topic shiji --notify          # 真发
 *   node daily-push.mjs --topic principles --dry --at "2026-11-01 12:10"
 *
 * 环境变量：PUSHPLUS_TOKEN（必填）、DRY_RUN=1（不真发）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUSHPLUS_ENDPOINT = "https://www.pushplus.plus/send";
const OFFSET_MINUTES = 8 * 60;

const pad = (value) => String(value).padStart(2, "0");

/** 上海时间 yyyy-mm-dd。 */
export function shanghaiDate(date = new Date()) {
  const shifted = new Date(date.getTime() + OFFSET_MINUTES * 60000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/** 今天该第几条（0 基）；还没到开始日期返回 -1。 */
export function indexFor(data, date = new Date()) {
  const offset = daysBetween(data.startDate, shanghaiDate(date));
  if (offset < 0) return -1;
  return offset % data.items.length;
}

/* ------------------------------------------------------------ 渲染 */

/** 原则：一句原则 + 来历 + 追问。 */
function renderPrinciples(data, item, index) {
  return [
    `📖 ${data.title} · 第 ${index + 1} 天`,
    `${item.source}`,
    "",
    `「${item.principle}」`,
    "",
    "—— 来历 ——",
    item.background,
    "",
    "—— 追问 ——",
    item.question,
    ...(item.closing ? ["", "—— 尾声 ——", item.closing] : []),
  ].join("\n");
}

/** 史记：原文 / 注解 / 白话 / 背景 / 赏析 / 想一想。 */
function renderShiji(data, item, index) {
  const head = [`📚 ${data.title} · 第 ${index + 1} 天`, `《史记·${item.chapter}》｜${item.figure}（${item.era}）`, ""];
  const body = [
    "—— 原文 ——",
    item.original,
    "",
    "—— 注解 ——",
    item.gloss,
    "",
    "—— 白话 ——",
    item.translation,
    "",
    "—— 背景 ——",
    item.background,
    "",
    "—— 赏析 ——",
    item.appreciation,
    "",
    "—— 想一想 ——",
    Array.isArray(item.questions) ? item.questions.join("\n") : String(item.questions ?? ""),
  ];
  const closing = item.closing ? ["", "—— 尾声 ——", item.closing] : [];
  return [...head, ...body, ...closing].join("\n");
}

export function render(data, item, index) {
  return data.topic === "shiji" ? renderShiji(data, item, index) : renderPrinciples(data, item, index);
}

/** 推送标题：微信通知栏只能看到这一行。 */
export function renderTitle(data, item) {
  if (data.topic === "shiji") {
    const head = String(item.headline ?? item.original?.slice(0, 24) ?? "").trim();
    const tail = `—《${item.chapter}》`;
    const budget = 60 - tail.length - 2;
    const quote = head.length > budget ? `${head.slice(0, Math.max(4, budget - 1))}…` : head;
    return `「${quote}」${tail}`;
  }
  const tail = `（${item.source}）`;
  const budget = 60 - tail.length - 2;
  const principle = String(item.principle ?? "").trim();
  const text = principle.length > budget ? `${principle.slice(0, Math.max(4, budget - 1))}…` : principle;
  return `「${text}」${tail}`;
}

/* ------------------------------------------------------------ 推送 */

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
  if (process.env.DRY_RUN === "1") return { status: 200, body: '{"code":200,"msg":"dry-run（没有真的发）"}' };
  return httpsPost(
    PUSHPLUS_ENDPOINT,
    { "Content-Type": "application/json; charset=utf-8" },
    JSON.stringify({ token, title, content, template: "txt" }),
  );
}

/* ------------------------------------------------------------ 命令行 */

function parseArgs(argv) {
  const args = { notify: false, dry: false, topic: "principles" };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--notify") args.notify = true;
    else if (item === "--dry") args.dry = true;
    else if (item === "--topic") args.topic = argv[++index];
    else if (item === "--day") args.day = Number(argv[++index]);
    else if (item === "--at") args.at = argv[++index];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataPath = join(HERE, `${args.topic}.json`);
  let data;
  try {
    data = JSON.parse(readFileSync(dataPath, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    console.error(`读不到 ${dataPath}：${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(data.items) || data.items.length === 0) throw new Error(`${args.topic}.json 里没有条目`);

  const now = args.at ? new Date(`${args.at.replace(" ", "T")}:00+08:00`) : new Date();
  const explicitDay = Number.isFinite(args.day) && args.day > 0;

  let index;
  if (explicitDay) {
    index = args.day - 1;
  } else {
    index = indexFor(data, now);
    if (index < 0) {
      console.log(`还没到开始日期（${data.startDate}），今天不推送。`);
      return;
    }
  }

  const item = data.items[index % data.items.length];
  if (!item) throw new Error(`找不到第 ${index + 1} 条`);

  const text = render(data, item, index % data.items.length);
  const title = renderTitle(data, item);
  const chars = text.replace(/\s/gu, "").length;

  console.log(`主题：${data.topic}｜日期：${shanghaiDate(now)}｜第 ${(index % data.items.length) + 1} / ${data.items.length} 条｜${chars} 字`);
  console.log(`推送标题（${title.length} 字）：${title}`);
  console.log("─".repeat(64));
  console.log(text);
  console.log("─".repeat(64));

  if (args.dry || !args.notify) {
    if (!args.dry) console.log("\n（预演：加 --notify 才会真的推送）");
    return;
  }

  const token = process.env.PUSHPLUS_TOKEN ?? "";
  if (!token) {
    console.error("缺少环境变量 PUSHPLUS_TOKEN");
    process.exitCode = 1;
    return;
  }
  const result = await push(token, title, text);
  console.log(`\n推送结果：HTTP ${result.status}｜${result.body}`);
  if (result.status !== 200) process.exitCode = 1;
}

if (process.argv[1]) {
  const { pathToFileURL } = await import("node:url");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
}

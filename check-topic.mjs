#!/usr/bin/env node
/**
 * 批次体检：原则 / 史记 两个主题的卡片
 *
 * 用法：
 *   node check-topic.mjs --topic principles --file batches/p1.json
 *   node check-topic.mjs --topic shiji --file batches/s1.json
 *
 * 检查项：
 *   ① 字段齐全、id 唯一、无英文双引号、无 BOM、无替换字符
 *   ② 渲染字数落在区间内（原则 440~620 / 史记 850~1250）
 *   ③ 史记：原文长度 100~200 字
 *   ④ 史记：原文能在 _shiji/ 里下载的维基文库页面中找到（逐字，容标点差异）
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { render } from "./daily-push.mjs";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 只保留汉字序列，用于逐字比对。 */
function normalize(text) {
  return String(text ?? "").replace(/[^\p{Script=Han}]/gu, "");
}

function htmlToText(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, "");
}

function loadCorpus() {
  const dir = join(HERE, "_shiji");
  if (!existsSync(dir)) return [];
  const pages = [];
  for (const file of readdirSync(dir)) {
    if (!/\.html?$/u.test(file)) continue;
    pages.push(normalize(htmlToText(readFileSync(join(dir, file), "utf8"))));
  }
  return pages;
}

const argv = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

const topic = arg("--topic");
const file = arg("--file");
if (!topic || !file) {
  console.error("用法：node check-topic.mjs --topic principles|shiji --file batches/xxx.json");
  process.exit(1);
}

const path = join(HERE, file);
if (!existsSync(path)) {
  console.error(`文件不存在：${path}`);
  process.exit(1);
}

const rawBytes = readFileSync(path);
if (rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf) {
  console.error("❌ 文件带 UTF-8 BOM，请去掉 BOM 再存");
  process.exit(1);
}

const parsed = JSON.parse(rawBytes.toString("utf8"));
const items = Array.isArray(parsed) ? parsed : parsed.items ?? [];
const problems = [];
const ids = new Set();

const FIELDS = {
  principles: ["id", "principle", "source", "background", "question"],
  shiji: ["id", "chapter", "figure", "era", "headline", "original", "gloss", "translation", "background", "appreciation", "questions"],
};
const RANGE = { principles: [420, 640], shiji: [950, 1400] };

const corpus = topic === "shiji" ? loadCorpus() : [];
const rows = [];

for (const [index, item] of items.entries()) {
  const label = `第 ${index + 1} 条（${item.id ?? "无 id"}）`;
  for (const field of FIELDS[topic]) {
    const value = item[field];
    const empty = Array.isArray(value) ? value.length === 0 : !value || !String(value).trim();
    if (empty) problems.push(`${label} 缺少 ${field}`);
  }
  if (item.id) {
    if (ids.has(item.id)) problems.push(`${label} id 重复`);
    ids.add(item.id);
  }
  // 英文双引号会破坏 JSON，也说明是直接从英文粘贴的
  for (const field of FIELDS[topic]) {
    const value = item[field];
    if (typeof value === "string" && value.includes('"')) problems.push(`${label} 的 ${field} 含英文双引号`);
    if (typeof value === "string" && (value.includes("\uFFFD") || /[\u0080-\u00FF]{2,}/u.test(value))) {
      problems.push(`${label} 的 ${field} 含乱码`);
    }
  }

  // 字数：**直接调用引擎的 render**，保证体检口径 = 真实推送长度
  // （今天已经栽过一次：体检漏算小标题和 closing，报告比实际少几十字）
  const rendered = render({ topic, title: "X" }, { ...item, closing: undefined }, index);
  const chars = rendered.replace(/\s/gu, "").length;
  const totalChars = render({ topic, title: "X" }, item, index).replace(/\s/gu, "").length;
  const [min, max] = RANGE[topic];
  if (chars < min || chars > max) problems.push(`${label} 正文 ${chars} 字越界（${min}~${max}）`);
  if (item.closing) {
    const closingChars = String(item.closing).replace(/\s/gu, "").length;
    if (closingChars < 100 || closingChars > 200) {
      problems.push(`${label} closing ${closingChars} 字（要求 100~200）`);
    }
  }

  // 史记原文长度 + 溯源
  let trace = "";
  if (topic === "shiji") {
    const original = String(item.original ?? "");
    const len = original.replace(/[^\p{Script=Han}]/gu, "").length;
    if (len < 100 || len > 200) problems.push(`${label} 原文 ${len} 字（要求 100~200）`);
    if (corpus.length === 0) {
      trace = "无语料";
    } else {
      const needle = normalize(original);
      const hit = corpus.find((page) => page.includes(needle));
      if (hit) {
        trace = "✓原句";
      } else {
        // 退化检查：取三处 12 字片段
        const probes = [0, Math.floor(needle.length / 2), needle.length - 12].map((start) => needle.slice(start, start + 12));
        const matched = probes.filter((probe) => probe.length === 12 && corpus.some((page) => page.includes(probe))).length;
        trace = `片段 ${matched}/3`;
        if (matched < 3) problems.push(`${label} 原文在语料里只匹配到 ${matched}/3 个片段，可能有改字或不是这一卷`);
      }
    }
  }

  rows.push({ index: index + 1, id: item.id, chars, totalChars, trace });
}

console.log(`=== ${topic} 体检：${file} ===`);
console.log(`条目 ${items.length} 条｜语料 ${corpus.length} 页${topic === "shiji" ? "（_shiji）" : ""}\n`);
for (const row of rows) {
  const [min, max] = RANGE[topic];
  const ok = row.chars >= min && row.chars <= max;
  console.log(`  ${row.index}. ${String(row.id ?? "").padEnd(6)} 正文${String(row.chars).padStart(4)} 总${String(row.totalChars).padStart(4)} ${ok ? "✓" : "✗"} ${row.trace}`);
}
const count = rows.length;
const avg = Math.round(rows.reduce((sum, row) => sum + row.chars, 0) / (count || 1));
console.log(`\n平均 ${avg} 字｜目标 ${RANGE[topic][0]}~${RANGE[topic][1]}`);

if (problems.length === 0) {
  console.log("✅ 全部通过");
} else {
  console.log(`❌ ${problems.length} 个问题：`);
  for (const problem of problems) console.log(`  · ${problem}`);
  process.exitCode = 1;
}

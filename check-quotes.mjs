#!/usr/bin/env node
/**
 * 推文库体检：字段完整性、字数范围、id 唯一性、核对状态
 * 用法：node check-quotes.mjs [--min 380] [--max 620]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "./daily-quote.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const numberArg = (name, fallback) => {
  const index = argv.indexOf(name);
  const value = index >= 0 ? Number(argv[index + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};
const MIN = numberArg("--min", 380);
const MAX = numberArg("--max", 620);

// --file 可以指定要体检的文件（用于审核分批交付的批次文件）
const fileArgIndex = argv.indexOf("--file");
const targetPath = fileArgIndex >= 0 ? join(HERE, argv[fileArgIndex + 1]) : join(HERE, "quotes.json");
const isBatchFile = targetPath.endsWith("quotes.json") === false;

const rawData = JSON.parse(readFileSync(targetPath, "utf8").replace(/^\uFEFF/u, ""));
// 批次文件是数组，没有 data.title；给个默认标题，否则渲染成「📖 undefined」每条多算 5 字
const data = Array.isArray(rawData) ? { title: "毛选日读", items: rawData } : rawData;
const items = data.items ?? [];
const problems = [];
const seen = new Set();
const counts = [];

if (!isBatchFile) {
  if (!data.startDate || !/^\d{4}-\d{2}-\d{2}$/u.test(data.startDate)) problems.push(`startDate 缺失或格式不对：${data.startDate}`);
  if (!data.title) problems.push("缺少 title");
}

items.forEach((item, index) => {
  const label = `第 ${index + 1} 条（${item.id ?? "无 id"}）`;
  for (const field of ["id", "title", "date", "quote", "excerpt", "context", "thought"]) {
    if (!item[field] || !String(item[field]).trim()) problems.push(`${label} 缺少 ${field}`);
  }
  // 乱码检测：PowerShell 用 ANSI 写文件时中文会被写成 GBK 字节再按 UTF-8 读，
  // 结果里会出现 U+FFFD 或 Latin-1 补充区字符，这里直接拦下来。
  for (const field of ["title", "quote", "excerpt", "context", "thought"]) {
    const text = String(item[field] ?? "");
    if (text.includes("\uFFFD")) problems.push(`${label} 的 ${field} 含替换字符 U+FFFD（编码坏了）`);
    else if (/[\u0080-\u00FF]{2,}/u.test(text)) problems.push(`${label} 的 ${field} 含疑似 Latin-1 乱码`);
  }
  if (item.id) {
    if (seen.has(item.id)) problems.push(`${label} 的 id 重复`);
    seen.add(item.id);
  }
  if (item.verified !== true) problems.push(`${label} 还没核对（verified≠true）`);
  if (item.volume !== 1 && item.volume !== 2 && item.volume !== 3 && item.volume !== 4) {
    problems.push(`${label} 的 volume 应该是 1~4，现在是 ${item.volume}`);
  }
  if (!item.title || !item.quote || !item.excerpt || !item.context || !item.thought) return;
  const chars = render(data, item, index).replace(/\s/gu, "").length;
  counts.push({ index: index + 1, id: item.id, chars, quoteChars: String(item.quote).length });
  if (chars < MIN) problems.push(`${label} 偏短：${chars} 字（下限 ${MIN}）`);
  if (chars > MAX) problems.push(`${label} 偏长：${chars} 字（上限 ${MAX}）`);
});

console.log(`=== 推文库体检 ===`);
console.log(`条目：${items.length} 条｜目标：50 条｜开始日期：${data.startDate}`);
const avg = counts.length ? Math.round(counts.reduce((sum, item) => sum + item.chars, 0) / counts.length) : 0;
console.log(`平均字数：${avg} 字（范围 ${MIN}~${MAX}）`);
const shortest = counts.reduce((a, b) => (a.chars <= b.chars ? a : b), counts[0]);
const longest = counts.reduce((a, b) => (a.chars >= b.chars ? a : b), counts[0]);
if (shortest) console.log(`最短：第 ${shortest.index} 条 ${shortest.chars} 字｜最长：第 ${longest.index} 条 ${longest.chars} 字`);

const byVolume = {};
for (const item of items) byVolume[item.volume] = (byVolume[item.volume] ?? 0) + 1;
console.log(`分卷：一 ${byVolume[1] ?? 0}｜二 ${byVolume[2] ?? 0}｜三 ${byVolume[3] ?? 0}｜四 ${byVolume[4] ?? 0}`);
if (items.length < 50) console.log(`提醒：还差 ${50 - items.length} 条才够 50 天`);

console.log("");
if (problems.length === 0) {
  console.log("✅ 全部通过");
} else {
  console.log(`❌ ${problems.length} 个问题：`);
  for (const problem of problems) console.log(`  · ${problem}`);
  process.exitCode = 1;
}

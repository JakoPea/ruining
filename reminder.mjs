#!/usr/bin/env node
/**
 * 课表提醒（云端可跑，零依赖）
 * ==========================
 *
 * 核心是纯函数 dueReminders()：给定课表和"现在"，算出这一刻该不该提醒。
 * 于是它可以跑在任何地方——GitHub Actions、云函数、你自己的电脑，逻辑完全一致。
 *
 * 用法：
 *   node reminder.mjs --check                     打印课表与当前状态（不发送）
 *   node reminder.mjs --at "2026-10-19 07:50"     模拟某个时刻（不发送）
 *   node reminder.mjs --notify                    该提醒就推送（云端 cron 用这个）
 *   node reminder.mjs --notify --channel qq       推送到 QQ 私聊（本机 NapCat，电脑开着时用）
 *
 * 通道（可同时开多个，用 --channel 逗号分隔）：
 *   email    写出 mail.txt，由外层用 curl 走 SMTP 发（见 .github/workflows）
 *   webhook  POST 到 WEBHOOK_URL：自动适配 PushPlus / 企业微信机器人 / Bark
 *   qq       调本机 NapCat 的 send_private_msg（需要电脑开着）
 *
 * 去重：发过的提醒记在 sent.json，同一个"课程+上课时刻"只发一次。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEDULE_PATH = process.env.SCHEDULE_PATH ?? join(HERE, "schedule.json");
const SENT_PATH = join(HERE, "sent.json");
const MAIL_PATH = join(HERE, "mail.txt");

/* ------------------------------------------------------------ 时间处理 */

const TIME_ZONE = "Asia/Shanghai";

/**
 * 把一个时刻换算成课表需要的本地信息。
 * 云端 runner 的时区是 UTC，所以这里显式按 TIME_ZONE 换算，绝不依赖进程时区。
 */
export function localParts(date, timeZone = TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    minutes: Number(parts.hour === "24" ? "0" : parts.hour) * 60 + Number(parts.minute),
    weekday: weekdayMap[parts.weekday] ?? 0,
  };
}

/** 日期字符串（YYYY-MM-DD）距 termStart 有几个整天。 */
function daysBetween(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
}

/** "HH:MM" → 从零点起的分钟数。 */
export function toMinutes(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(String(hhmm).trim());
  if (!match) throw new Error(`时间格式应为 HH:MM，收到「${hhmm}」`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 现在是第几教学周（第 1 周从 termStart 那天算起）。 */
export function weekNumber(schedule, localDate) {
  const start = schedule.termStart;
  if (!start) return 1;
  return Math.floor(daysBetween(start, localDate) / 7) + 1;
}

/* ------------------------------------------------------------ 核心判定 */

/**
 * 算出这一刻该提醒哪些课。
 * @param {object} schedule - 课表（见 schedule.json）
 * @param {Date} now - 当前时刻
 * @returns {Array<{key: string, course: object, week: number, minutesUntilStart: number, startAt: string}>}
 */
export function dueReminders(schedule, now) {
  const timeZone = schedule.timezone ?? TIME_ZONE;
  const local = localParts(now, timeZone);
  const week = weekNumber(schedule, local.date);
  const lead = Number(schedule.remindBeforeMinutes ?? 10);
  const window = Number(schedule.windowMinutes ?? 8);
  const due = [];

  for (const course of schedule.courses ?? []) {
    if (Number(course.weekday) !== local.weekday) continue;
    const weeks = Array.isArray(course.weeks) && course.weeks.length > 0 ? course.weeks : null;
    if (weeks && !weeks.includes(week)) continue;
    const startMinutes = toMinutes(course.start);
    const remindAt = startMinutes - lead;
    // 落在 [提醒时刻, 提醒时刻+窗口) 内才触发；窗口要略大于 cron 间隔，
    // 这样即使某次调度被延迟几分钟也不会漏。
    if (local.minutes < remindAt || local.minutes >= remindAt + window) continue;
    due.push({
      key: `${local.date} ${course.start} ${course.name}`,
      course,
      week,
      minutesUntilStart: startMinutes - local.minutes,
      startAt: `${local.date} ${course.start}`,
    });
  }
  return due;
}

/* ------------------------------------------------------------ 文案 */

export function buildMessage(item, schedule) {
  const { course, minutesUntilStart, week } = item;
  const place = course.location ? `（${course.location}）` : "";
  const lines = [
    `⏰ ${minutesUntilStart} 分钟后上课：${course.name}${place}`,
    `上课时间：${course.start}${course.end ? `-${course.end}` : ""}｜第 ${week} 教学周`,
  ];
  if (course.teacher) lines.push(`任课老师：${course.teacher}`);
  lines.push("", "别忘了提前签到，早点过去占个位置～");
  return lines.join("\n");
}

/**
 * 邮件头里的非 ASCII 文本必须用 RFC 2047 编码，否则收件端显示乱码。
 * 长文本切成多个 encoded-word（每段不超过 75 字符）。
 */
export function encodeHeaderText(value) {
  const raw = String(value ?? "");
  if (!/[^\x20-\x7E]/u.test(raw)) return raw;
  const base64 = Buffer.from(raw, "utf8").toString("base64");
  const words = [];
  // 每段 60 字符：60 是 4 的倍数（否则单个 encoded-word 的 base64 非法），
  // 加上 "=?UTF-8?B?" 和 "?=" 共 72 字符，仍不超过 75。
  for (let index = 0; index < base64.length; index += 60) {
    words.push(`=?UTF-8?B?${base64.slice(index, index + 60)}?=`);
  }
  return words.join("\r\n ");
}

export function buildMail(item, schedule, to, subjectPrefix = "", bodyOverride = "") {
  const subject = `${subjectPrefix}【上课提醒】${item.minutesUntilStart} 分钟后 ${item.course.name}`;
  const body = bodyOverride || buildMessage(item, schedule);
  const from = process.env.SMTP_USER ?? "reminder@localhost";
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderText(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2, 8)}@qq-bot>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    "",
  ].join("\r\n");
}

/**
 * 找接下来 days 天内最近的一节课（用于 --force 发测试提醒）。
 * @returns {{item: object}|null}
 */
export function findUpcoming(schedule, now, days = 14) {
  const timeZone = schedule.timezone ?? TIME_ZONE;
  let best = null;
  for (let offset = 0; offset <= days; offset += 1) {
    const probe = new Date(now.getTime() + offset * 86400000);
    const local = localParts(probe, timeZone);
    const week = weekNumber(schedule, local.date);
    for (const course of schedule.courses ?? []) {
      if (Number(course.weekday) !== local.weekday) continue;
      const weeks = Array.isArray(course.weeks) && course.weeks.length > 0 ? course.weeks : null;
      if (weeks && !weeks.includes(week)) continue;
      const startMinutes = toMinutes(course.start);
      const startMs = Date.UTC(
        Number(local.date.slice(0, 4)),
        Number(local.date.slice(5, 7)) - 1,
        Number(local.date.slice(8, 10)),
        Math.floor(startMinutes / 60),
        startMinutes % 60,
      ) - 8 * 3600000;
      if (startMs <= now.getTime()) continue;
      if (!best || startMs < best.startMs) {
        best = {
          startMs,
          item: {
            key: `force-${local.date}-${course.start}-${course.name}`,
            course,
            week,
            minutesUntilStart: Math.round((startMs - now.getTime()) / 60000),
            startAt: `${local.date} ${course.start}`,
          },
        };
      }
    }
  }
  return best?.item ?? null;
}

/* ------------------------------------------------------------ 去重记录 */

function loadSent() {
  if (!existsSync(SENT_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SENT_PATH, "utf8"));
  } catch {
    return {};
  }
}

function markSent(sent, key) {
  sent[key] = new Date().toISOString();
  // 只留最近 200 条，别让文件无限长大
  const keys = Object.keys(sent);
  if (keys.length > 200) {
    for (const old of keys.slice(0, keys.length - 200)) delete sent[old];
  }
  writeFileSync(SENT_PATH, `${JSON.stringify(sent, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------ 推送通道 */

/** 把一条提醒按指定通道推出去。 */
async function deliver(item, schedule, channels, subjectPrefix = "", bodyOverride = "") {
  const body = bodyOverride || buildMessage(item, schedule);
  const title = `${subjectPrefix}【上课提醒】${item.minutesUntilStart} 分钟后 ${item.course.name}`;
  for (const channel of channels) {
    try {
      if (channel === "email") {
        const to = process.env.MAIL_TO ?? process.env.SMTP_USER ?? "";
        if (!to) throw new Error("缺少 MAIL_TO / SMTP_USER");
        writeFileSync(MAIL_PATH, buildMail(item, schedule, to, subjectPrefix, bodyOverride), "utf8");
        console.log(`email：已写出 ${MAIL_PATH}（交给外层 curl 发送）`);
      } else if (channel === "webhook") {
        if (!process.env.WEBHOOK_URL) throw new Error("缺少 WEBHOOK_URL");
        console.log(`webhook：${await pushWebhook(process.env.WEBHOOK_URL, title, body)}`);
      } else if (channel === "qq") {
        const userId = process.env.QQ_TARGET ?? "";
        if (!userId) throw new Error("缺少 QQ_TARGET");
        console.log(`qq：${await pushQQ(userId, body)}`);
      } else {
        console.log(`未知通道 ${channel}，跳过`);
      }
    } catch (error) {
      console.error(`通道 ${channel} 发送失败：${error.message}`);
    }
  }
}

async function pushWebhook(url, title, body) {
  if (/pushplus\.plus|pushplus\.ren/u.test(url)) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: process.env.PUSHPLUS_TOKEN ?? "", title, content: body, template: "txt" }),
    });
    return `pushplus HTTP ${response.status}`;
  }
  if (/qyapi\.weixin\.qq\.com/u.test(url)) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: `${title}\n${body}` } }),
    });
    return `企业微信 HTTP ${response.status}`;
  }
  // Bark 默认形态：GET /<title>/<body>
  const response = await fetch(`${url.replace(/\/+$/u, "")}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
  return `Bark HTTP ${response.status}`;
}

async function pushQQ(userId, body, apiBase = "http://127.0.0.1:3000") {
  const response = await fetch(`${apiBase.replace(/\/+$/u, "")}/send_private_msg`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: String(userId), message: [{ type: "text", data: { text: body } }] }),
  });
  const payload = await response.json().catch(() => ({}));
  return `QQ HTTP ${response.status} ${payload.status ?? ""}`;
}

/* ------------------------------------------------------------ 命令行 */

function parseArgs(argv) {
  const args = { channels: [], notify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--notify") args.notify = true;
    else if (item === "--force") args.force = true;
    else if (item === "--check") args.check = true;
    else if (item === "--at") args.at = argv[++index];
    else if (item === "--channel") args.channels.push(...String(argv[++index]).split(",").map((s) => s.trim()).filter(Boolean));
    else if (item === "--schedule") args.schedule = argv[++index];
  }
  if (args.channels.length === 0) {
    args.channels = (process.env.REMIND_CHANNELS ?? "email").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const schedulePath = args.schedule ?? SCHEDULE_PATH;
  // 去掉可能的 UTF-8 BOM：从某些编辑器/Secret 复制粘贴时很容易带上，
  // 带着它 JSON.parse 会直接抛 "Unexpected token"。
  const schedule = JSON.parse(readFileSync(schedulePath, "utf8").replace(/^\uFEFF/u, ""));
  const now = args.at ? new Date(args.at.replace(" ", "T") + ":00+08:00") : new Date();
  const local = localParts(now, schedule.timezone);

  if (args.check) {
    console.log(`课表：${schedulePath}`);
    console.log(`开学第一周周一：${schedule.termStart}`);
    console.log(`当前（${schedule.timezone ?? TIME_ZONE}）：${local.date} 周${local.weekday} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}｜第 ${weekNumber(schedule, local.date)} 教学周`);
    console.log(`共 ${(schedule.courses ?? []).length} 门课，提前 ${schedule.remindBeforeMinutes ?? 10} 分钟提醒（命中窗口 ${schedule.windowMinutes ?? 8} 分钟）`);
    for (const course of schedule.courses ?? []) {
      console.log(`  · 周${course.weekday} ${course.start}-${course.end ?? ""} ${course.name} ${course.location ?? ""} 周次[${(course.weeks ?? []).join(",")}]`);
    }
    return;
  }

  // --force：不管课表命中与否，立刻发一封"最近一节课"的测试提醒。
  // 用来验证云端配置（SMTP/推送）是否真的通了。
  if (args.force) {
    const upcoming = findUpcoming(schedule, now);
    const item = upcoming ?? {
      key: `force-test-${Date.now()}`,
      course: { name: "测试课程", location: "测试教室", start: "12:00", end: "12:45" },
      week: 0,
      minutesUntilStart: 10,
      startAt: `${local.date} 12:00`,
    };
    console.log(upcoming
      ? `[测试] 用接下来最近的一节课发一封测试提醒：${item.course.name}（${item.startAt}）`
      : "[测试] 找不到即将到来的课，用占位内容发一封测试提醒");
    await deliver(
      item,
      schedule,
      args.channels,
      "[测试] ",
      [
        "这是一封测试提醒，用来确认推送通道能用。",
        "真正的提醒会在每节课前 10 分钟发出，长这样：",
        "",
        buildMessage({ ...item, minutesUntilStart: 10 }, schedule),
      ].join("\n"),
    );
    return;
  }

  const due = dueReminders(schedule, now);
  const sent = loadSent();
  const fresh = due.filter((item) => !sent[item.key]);

  if (due.length === 0) {
    console.log(`[${local.date} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}] 现在没有需要提醒的课`);
    return;
  }
  for (const item of due) {
    const mark = sent[item.key] ? "（已发过，跳过）" : "";
    console.log(`[命中] ${item.course.name} ${item.startAt} → ${item.minutesUntilStart} 分钟后上课 ${mark}`);
  }
  if (!args.notify) {
    console.log("\n（这是预演，没有真的发送；加 --notify 才会推送）\n");
    console.log(buildMessage(fresh[0] ?? due[0], schedule));
    return;
  }
  if (fresh.length === 0) {
    console.log("都发过了，本次不重复推送。");
    return;
  }

  for (const item of fresh) {
    await deliver(item, schedule, args.channels, "");
    markSent(sent, item.key);
  }
}

// 只有被当作脚本直接运行时才执行（被 import 做测试时保持安静）
const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  await main();
}

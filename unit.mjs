// 课表提醒核心逻辑的单测：node reminder/unit.mjs
import assert from "node:assert/strict";
import { buildMessage, dueReminders, localParts, toMinutes, weekNumber } from "./reminder.mjs";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

// 固定课表：2026-09-07 是周一（第 1 周）
const schedule = {
  timezone: "Asia/Shanghai",
  remindBeforeMinutes: 10,
  windowMinutes: 8,
  termStart: "2026-09-07",
  courses: [
    { name: "高等数学", location: "教三 201", weekday: 1, start: "08:00", end: "09:40", weeks: [1, 2, 3] },
    { name: "数据结构", location: "实验楼 B404", weekday: 3, start: "14:00", end: "15:40", weeks: [2, 4] },
  ],
};

/** 上海时间 → Date（用 +08:00 偏移构造，避免依赖进程时区）。 */
const shanghai = (text) => new Date(`${text.replace(" ", "T")}:00+08:00`);

console.log("localParts（显式按上海时区换算，云端 UTC 也不会错）");
test("UTC 23:50 = 上海次日 07:50（周一）", () => {
  const local = localParts(new Date("2026-09-06T23:50:00Z"));
  assert.equal(local.date, "2026-09-07");
  assert.equal(local.hour, 7);
  assert.equal(local.minute, 50);
  assert.equal(local.weekday, 1);
});
test("分钟数换算", () => {
  assert.equal(localParts(shanghai("2026-09-07 08:00")).minutes, 480);
});

console.log("weekNumber");
test("开学当天是第 1 周", () => {
  assert.equal(weekNumber(schedule, "2026-09-07"), 1);
});
test("第 2 周周一", () => {
  assert.equal(weekNumber(schedule, "2026-09-14"), 2);
});
test("周中仍属同一教学周", () => {
  assert.equal(weekNumber(schedule, "2026-09-16"), 2);
});

console.log("toMinutes");
test("08:00 → 480", () => {
  assert.equal(toMinutes("08:00"), 480);
});
test("格式错误要报错", () => {
  assert.throws(() => toMinutes("8点"), /HH:MM/u);
});

console.log("dueReminders（命中窗口）");
test("07:50 命中 08:00 的课", () => {
  const due = dueReminders(schedule, shanghai("2026-09-07 07:50"));
  assert.equal(due.length, 1);
  assert.equal(due[0].course.name, "高等数学");
  assert.equal(due[0].minutesUntilStart, 10);
});
test("07:49 还不该提醒", () => {
  assert.equal(dueReminders(schedule, shanghai("2026-09-07 07:49")).length, 0);
});
test("窗口内延迟几分钟仍能命中（cron 延迟兜底）", () => {
  assert.equal(dueReminders(schedule, shanghai("2026-09-07 07:56")).length, 1);
});
test("窗口过后不再提醒（避免上课了才提醒）", () => {
  assert.equal(dueReminders(schedule, shanghai("2026-09-07 07:59")).length, 0);
});
test("周二没有课", () => {
  assert.equal(dueReminders(schedule, shanghai("2026-09-08 07:50")).length, 0);
});
test("非上课周不提醒（第 5 周周一没课）", () => {
  assert.equal(dueReminders(schedule, shanghai("2026-10-05 07:50")).length, 0);
});
test("只有该周有课才提醒（数据结构第 2 周有课）", () => {
  assert.equal(dueReminders(schedule, shanghai("2026-09-16 13:50")).length, 1);
  assert.equal(dueReminders(schedule, shanghai("2026-09-23 13:50")).length, 0, "第 3 周没有这门课");
});

console.log("提醒文案");
test("包含课名、地点、时间、剩余分钟、签到提示", () => {
  const [item] = dueReminders(schedule, shanghai("2026-09-07 07:50"));
  const text = buildMessage(item, schedule);
  assert.ok(text.includes("10 分钟后上课"), "应写明几分钟后");
  assert.ok(text.includes("高等数学"));
  assert.ok(text.includes("教三 201"));
  assert.ok(text.includes("08:00"));
  assert.ok(text.includes("签到"), "应提醒签到");
  assert.ok(text.includes("第 1 教学周"));
});

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;

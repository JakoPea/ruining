# 课表提醒（跑在 GitHub 上，与你电脑无关）

每 5 分钟检查一次课表，在**上课前 10 分钟**把提醒推到你的邮箱。
电脑关机、断网、上课路上都不影响。

```
schedule.json(Secret) ──▶ reminder.mjs 判断"这一刻该不该提醒" ──▶ QQ 邮件 ──▶ 手机 QQ 邮箱 App 推送
```

## 一、第一次配置（约 10 分钟）

### 1. 拿 QQ 邮箱的 SMTP 授权码

QQ 邮箱网页版 → 设置 → **账户** → 拉到底「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务」
→ 开启 **IMAP/SMTP 服务** → 按提示用手机发条短信验证 → 得到一串 **16 位授权码**（不是 QQ 密码）。

### 2. 建一个 GitHub 仓库

- 打开 https://github.com/new
- 仓库名随意（如 `class-reminder`）
- **必须选 Public**（公开仓库的 Actions 不限时长；私有仓库每月 2000 分钟，5 分钟一次会超额）
- 勾选 "Add a README file" → Create repository

### 3. 上传这几个文件

| 文件 | 说明 |
|---|---|
| `reminder.mjs` | 核心逻辑 + 推送 |
| `unit.mjs` | 自测（可选，但建议传） |
| `.github/workflows/class-reminder.yml` | 定时任务 |

上传方式：仓库页 → **Add file → Upload files** → 把这两个 .js 拖进去 → Commit。

workflow 那个文件放在子目录里，用上传界面不太好摆，**推荐这样**：
仓库页 → **Add file → Create new file** → 文件名框里直接输入
`.github/workflows/class-reminder.yml`（斜杠会自动建目录）→ 把内容粘进去 → Commit。

### 4. 配置 Secrets

仓库 → **Settings → Secrets and variables → Actions → New repository secret**，逐个添加：

| Secret | 值 |
|---|---|
| `SMTP_USER` | 你的 QQ 邮箱，如 `2736701679@qq.com` |
| `SMTP_PASS` | 第 1 步拿到的**授权码** |
| `MAIL_TO` | 收件邮箱（可以就是 `SMTP_USER`） |
| `SCHEDULE_JSON` | 课表 JSON 全文（一行，从 `schedule.secret.txt` 整段复制） |

> 课表放在 Secret 里，所以仓库是公开的也不会泄露你的课表。

### 5. 跑一次测试

仓库 → **Actions** → 左侧选 `class-reminder` → 右侧 **Run workflow**
→ 把 `force` 勾成 **true** → Run。

这次会**立刻**发一封 `[测试]` 邮件（不管课表）。收到就说明配置成功了。

之后它每 5 分钟自动跑，命中「上课前 10 分钟」就会发信，不用你管。

## 二、日常

- **什么都不用做**。它自己跑。
- 想确认还活着：Actions 页面看最近一次运行是绿色。
- 想改课表：重新生成 `schedule.json`，更新 `SCHEDULE_JSON` 这个 Secret 即可。

## 三、本地调试

```bat
:: 看课表解析对不对
node reminder.mjs --check

:: 预演某个时刻（不发送）
node reminder.mjs --at "2026-10-19 10:00"

:: 本地真发一封测试信（需要设 SMTP_USER / SMTP_PASS / MAIL_TO 环境变量）
set REMIND_CHANNELS=email
node reminder.mjs --force --notify

:: 自测
node unit.mjs
```

## 四、想换成微信推送（比邮件更显眼）

1. 注册 https://www.pushplus.plus/ ，拿到 token；
2. 加一个 Secret `WEBHOOK_URL` = `https://www.pushplus.plus/send?token=你的token`；
3. 把 workflow 里的 `REMIND_CHANNELS: email` 改成 `REMIND_CHANNELS: webhook`（或 `email,webhook` 两个都发）。

企业微信机器人、Bark 也能用同一个 `WEBHOOK_URL`，脚本会按 URL 自动识别格式。

## 五、已知边界

- **时间精度**：GitHub 的 cron 最小 5 分钟且可能延迟，所以你实际会在**课前 10～18 分钟**收到提醒。
  想稳一点就把 `remindBeforeMinutes` 调到 12。需要精确到分钟请换腾讯云函数/Cloudflare Worker（逻辑不用改）。
- **去重**：`sent.json` 记录已发过的提醒，同一节课不会重复发两封（workflow 会把它提交回仓库）。
- **时区**：脚本显式按 `Asia/Shanghai` 计算，云端 runner 是 UTC 也不会错小时（有单测覆盖）。

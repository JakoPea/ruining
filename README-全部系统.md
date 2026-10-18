# 这个仓库在跑什么

四套每日推送，都跑在 GitHub Actions 上，**和你的电脑无关**（关机、断网、放假回家都不影响）。

| 系统 | 时间（北京） | 内容 | workflow | 数据文件 |
|---|---|---|---|---|
| **课表提醒** | 每 5 分钟检查，课前 10 分钟发 | 微信 + 邮件 | `class-reminder.yml` | Secret `SCHEDULE_JSON` |
| **毛选日读** | 07:00 | 名句 + 原文 + 时代背景 + 一问，约 480 字 | `daily-quote.yml` | `quotes.json` |
| **原则日读** | 12:10 | 一句原则 + 来历 + 追问，约 460 字 | `daily-principles.yml` | `principles.json` |
| **史记日读** | 22:00 | 原文 + 注解 + 白话 + 背景 + 赏析 + 两问，约 1150 字 | `daily-shiji.yml` | `shiji.json` |

另外还有一台**腾讯云函数**（`class-reminder`）每分钟检查一次课表，只发微信——它和 GitHub 那套互为备份。

## 文件对照

```
.github/workflows/
├── class-reminder.yml      课表（每 5 分钟）
├── daily-quote.yml         毛选（07:00）
├── daily-principles.yml    原则（12:10）
└── daily-shiji.yml         史记（22:00）

quotes.json       毛选 50 条 + daily-quote.mjs（专用引擎）+ check-quotes.mjs
principles.json   原则 50 条 ┐
shiji.json        史记 50 条 ┼ daily-push.mjs（两套模板共用）+ check-topic.mjs
                             ┘

reminder.mjs      课表提醒逻辑 + unit.mjs（单测）
index.html        课表转换器（把教务页面转成 schedule.json）
sfcfn/index.js    腾讯云函数版课表提醒
```

## 内容来源

| | 来源 | 核对方式 |
|---|---|---|
| 毛选 | 求是网《毛泽东选集》各卷（人民出版社第二版录入本） | 每条引文逐字回查 176 页原文 |
| 原则 | 电子书《原则》（瑞·达利欧，刘波、綦相 译） | 原则逐字取自原书条目，编号沿用原书；83 个数字逐个回查 |
| 史记 | [维基文库《史记》](https://zh.wikisource.org/wiki/史記)（繁体，武英殿本系统） | 原文按锚点从页面切片，逐条校验"在原卷里连续命中" |

赏析里凡引用名家评点**都注明出处**（柳宗元、王安石、司马贞、班固、苏轼、贾谊等），作者自己的分析一律标「今按」，**没有编造的古人评语**。

## 三个机制说明

**① 取哪一条**：`index = (上海今天 - startDate) 的天数 % 条目数`。不存状态，50 天一轮，第 51 天回到第 1 条。

**② 没收到可以补**：Actions → 对应 workflow → Run workflow → `day` 填期数。

**③ 60 天不提交会被停**：GitHub 的规则。每两个月去 Actions 页面点一下 **Enable workflow** 即可恢复。

## 微信为什么只显示一行

PushPlus 走微信服务号时**默认只显示标题**，正文要点进链接才能看。所以三套日读都把最有价值的一句话放进了标题：

- 毛选 → 名句
- 原则 → 原则原文
- 史记 → 原文里最有钩子的一句（`headline`）

点进去才是完整内容。

## 隐私

- 课表存在 **Secret** 里，不进仓库
- `sent.json` 只记录"某天某节已提醒过"，不含课表内容
- 原文语料（《史记》各卷 HTML、毛选页面）只在本地用于核对，**没有上传仓库**

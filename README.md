# CoTeach——基于多智能体的师生协同教学平台

CoTeach 是一个给高校老师和学生用的教学平台。老师有一个 AI 助教（CoT 助教），说一句话就能建课程、布置和批改作业、发通知、备课；学生有一个 AI 学伴（CoT 学伴），按课程资料答疑，需要老师决定的事转到老师那里。分数、名单、统计这类要求准确的数据都由程序计算，模型只负责需要理解和判断的部分。

在线体验：https://teach.haovio.com

详细说明见 [技术文档](docs/技术文档.md) 和 [作品介绍](docs/作品介绍.md)。

## 主要功能

老师

- 首页和 CoT 助教：用一句话办事，比如「给计科2501 布置第四章作业，下周五交」「张浩然那题改成 25 分」；办过的事能撤回，意思不清楚时用选项卡片问老师；支持语音输入。
- 课程：加课码和二维码，学生自己加入；分作业、学情、成绩、成员四栏。
- 批改和讲评：助教照评分标准逐项给分、在原文上划批注，总分由程序加；老师改了一份的某一项，同样的问题可以一起改；讲评能下载 Word、发给学生。
- 学情：学生卡在哪几个知识点、下节课怎么讲，人数由程序统计。
- 备课：一句话备一节课，可以带上讲义和课件；助教做出教案、课件、练习题和课后作业，过程边做边显示；课件能放映、导出可编辑的 PPT。
- 消息：收件箱、课程群、私聊；通知看得到谁读了谁没读，签到出二维码，随机选人。
- 知识库：交 PDF、PPT、Word、图片、压缩包等资料，整理助手整理成笔记，原件只读保留，改动能撤回。

学生

- CoT 学伴：按课程资料包答疑、查自己的作业和分数，可以带截图和文件；要老师决定的事转给老师，老师回复后送回对话。
- 课程、消息、错题本：错题本列出丢了分的题，点「练一练」让学伴出一道类似的新题。

## 技术栈

- 前端：React 19、Vite、Tailwind CSS 4、TanStack Query
- 后端：Node.js 24、Hono、SQLite（node:sqlite）；每个知识库一个 Git 仓库
- 模型：Gemini、DeepSeek，经统一的模型层接入，主备切换、流式输出、工具调用
- 测试：node:test，265 条自动化测试；`tools/` 下有模型输出质量的评测工具

## 本地运行

需要先装好：

- Node.js 24 或更新（`node -v`）
- pnpm 10（`pnpm -v`，没有就 `npm i -g pnpm`）
- Git（知识库的历史存在 Git 里）
- 一个 DeepSeek 开放平台的 API key

```bash
git clone https://github.com/w2697134/CoTeach.git coteach
cd coteach
pnpm install
cp server/.env.example server/.env
```

在 `server/.env` 的 `CT_BOOT_DEEPSEEK_KEY=` 后面填上 key（只在第一次启动时读取）。然后开两个终端：

```bash
pnpm dev:server   # 后端，默认 127.0.0.1:18660
```

```bash
pnpm dev:web      # 前端，http://localhost:5190
```

浏览器打开 http://localhost:5190 ：

1. 点「注册」，用手机号建一个老师账号（本地不发短信）。
2. 新建课程，记下加课码；另开一个浏览器或无痕窗口，用加课码注册一个学生加入。
3. 老师在 CoT 助教里说「给这门课布置一份作业：用 for 循环求 1 到 100 的和，满分 10 分，明天交」；学生交作业，等助教批完看分数和批注；学生在 CoT 学伴里提问。

第一次启动会创建超级管理员 `root`，初始密码写在 `server/data/root-password.txt`。管理页可以开关老师注册、给账号发放或停用登录密钥、查看每个账号当天的模型调用次数。

想直接看一门有数据的课：在 `server/data/` 里放一个 `seed-demo.json`，内容写 `{"teacher":"<老师的账号名，即注册用的手机号>"}`。服务在半分钟内会建好「计科2501 Python 程序设计」：36 个虚构学生、4 份作业，答卷由真实模型批改，再写讲评、让几个学生问学伴。全程约 10 分钟，会产生模型调用费用。

生产构建：

```bash
pnpm build
NODE_ENV=production node server/dist/server.mjs
```

前端打包进 `server/dist/web`，由同一个进程提供；服务端打包成单个文件，运行时不需要 `node_modules`。

## 常用环境变量

完整列表见 `server/.env.example`。

| 变量 | 作用 |
|---|---|
| `CT_BOOT_DEEPSEEK_KEY` | 第一次启动时接入 DeepSeek，所有智能体默认用它 |
| `CT_DATA_DIR` | 数据目录，默认 `server/data`；同一个数据目录只能有一个服务在写 |
| `CT_PORT` | 后端端口，默认 18660 |
| `CT_FAST_AGENTS` | 哪些智能体先用备用模型（响应快的那个），默认 `ta,stu`，即 CoT 助教和学伴 |
| `CT_LOGIN_ONLY` | 只允许这几个账号登录（逗号分隔），有登录密钥的账号和管理员也能进；设置后关闭注册 |
| `CT_PASSWORD_LOGIN` | 设为 `off` 时只能用登录密钥登录（管理员除外），注册关闭 |
| `CT_DASHSCOPE_KEY` | 语音输入用的阿里云百炼 key；不配置就不显示话筒 |

再接一个 Gemini 接口作默认模型、DeepSeek 作备用的写法，也在 `server/.env.example` 里。

## 目录结构

```
server/src/
  assistant/   CoT 助教、CoT 学伴、代答助手、专门助手、课程资料包
  grading/     评分标准、批改队列、讲评、学情、相似度
  prep/        备课：教案、课件、题目、幻灯片、精修、核对
  classes/     课程（代码沿用 classes 这个名字）、名单、作业、成绩册
  messages/    收件箱、课程群、私聊、通知、签到、选人
  kb/          知识库（Git 仓库）、交资料与读资料、整理助手
  llm/         模型层：协议适配、主备切换、流式输出
  db/          SQLite 封装和迁移
server/tests/  自动化测试
web/src/       前端页面和组件
tools/         模型输出质量评测、演示答卷生成、登录密钥批量发放
docs/          作品介绍、技术文档和截图
```

## 测试

```bash
pnpm typecheck   # 前后端 TypeScript 严格检查
pnpm test        # 265 条自动化测试
```

`pnpm test` 不调用真实模型：模型的回答在测试里写好，或者由测试在本机起的假模型服务返回，不连外网，每次结果一样。

模型输出的质量用 `tools/` 下的评测工具测：在开发数据的副本上调用真实模型，由程序判分，改动发给模型的说明前后各跑一遍对比。这些工具会产生模型调用费用。例如在 `server` 目录运行 `node --import tsx ../tools/ta-measure/ruler.ts <标签>`，结果写在 `output/ta-measure/<标签>/`。

## 开发方式

项目使用 AI 编程工具 Claude Code 辅助编写代码和测试，需求、功能取舍和验收由团队负责。完整的提交记录保存在本仓库中。

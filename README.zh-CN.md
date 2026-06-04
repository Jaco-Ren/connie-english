# Connie's English Learning Tracker

**语言:** [English](README.md) | 简体中文

![Vanilla JS](https://img.shields.io/badge/Frontend-Vanilla%20JS-f7df1e?logo=javascript&logoColor=111)
![Supabase](https://img.shields.io/badge/Backend-Supabase-3ecf8e?logo=supabase&logoColor=white)
![Vercel](https://img.shields.io/badge/Deploy-Vercel-000?logo=vercel)
![Status](https://img.shields.io/badge/Status-Online%20Tracker-4c6fff)

一个给 Connie 使用、由 Jaco 监督审核的英语学习打卡系统。Connie 每天提交单词、四级阅读、四级听力的完成证明；Jaco 在线审核后才会计入积分，并可以通过留言和手动调分辅助监督。

项目使用原生 HTML/CSS/JavaScript 构建，后端依赖 Supabase Auth、PostgreSQL、Storage、Realtime 和 Row Level Security。没有前端框架，也没有构建步骤，适合作为一个轻量的在线学习监督工具。

## 功能概览

| 模块 | 当前实现 |
| --- | --- |
| 登录与角色 | Supabase Auth 登录后读取 `profiles.role`，自动切换 Connie 提交界面或 Jaco 审核界面 |
| 每日任务 | 单词 `+5`、四级阅读 `+7`、四级听力 `+8`；听力按隔天节奏显示 |
| 证明提交 | Connie 可上传图片证明；阅读和听力支持多张证明图 |
| 图片处理 | 前端压缩为 JPEG，最大宽度 1000px，降低上传体积 |
| 审核流程 | Jaco 可通过、退回、撤销通过、为过期任务开放补交，并删除 Connie 自定义任务；只有 `approved` 任务计入积分 |
| 积分系统 | 自动统计任务积分，并叠加 Jaco 的手动加分/扣分 |
| 留言系统 | Jaco 可给 Connie 留审核备注，Connie 也可给 Jaco 留言 |
| 周进度 | 展示本周完成率、全勤天数、连续全勤天数和提交记录 |
| 实时同步 | `tasks`、`notes`、`score_adjustments` 变化后两端实时刷新 |
| 权限保护 | Supabase RLS 区分 Connie 与 Jaco 的可读写范围 |

## 角色工作流

### Connie

1. 登录 Connie 账号。
2. 查看今日任务和本周进度。
3. 上传完成证明图片。
4. 等待 Jaco 审核。
5. 审核通过后获得积分；退回后可重新提交。
6. 查看 Jaco 留言，也可以给 Jaco 留言。

### Jaco

1. 登录 Jaco 账号。
2. 查看待审核任务列表。
3. 打开证明图片检查完成情况。
4. 选择通过或不通过。
5. 必要时撤销通过、删除自定义任务、手动加分/扣分。
6. 给 Connie 写当天提醒或反馈。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| Frontend | Vanilla HTML + CSS + JavaScript |
| Auth | Supabase Auth |
| Database | Supabase PostgreSQL |
| Storage | Supabase Storage bucket: `proofs` |
| Realtime | Supabase Realtime Postgres changes |
| Security | Supabase Row Level Security |
| Deployment | Vercel static site |

## 项目结构

```text
.
├── index.html                 # 页面骨架、登录区、主应用容器
├── styles.css                 # 响应式界面样式
├── app.js                     # 业务逻辑、渲染、上传、审核、实时同步
├── docs/
│   └── supabase-setup.md      # Supabase 表结构、RLS 和测试说明
└── supabase/
    └── rls.sql                # 可重复执行的 RLS / Storage / Realtime 配置脚本
```

## 核心数据表

| 表 | 用途 |
| --- | --- |
| `profiles` | 绑定 Supabase Auth 用户和业务角色：`connie` / `jaco` |
| `tasks` | 保存每天每类任务的提交状态、证明图片、提交时间和审核信息 |
| `notes` | 保存 Jaco 给 Connie 的备注，以及 Connie 给 Jaco 的留言 |
| `score_adjustments` | 保存 Jaco 的手动加分/扣分记录 |

详细字段、约束和权限策略见 [docs/supabase-setup.md](docs/supabase-setup.md)。

## 本地运行

这个项目不需要安装依赖。

1. 克隆仓库。
2. 用浏览器打开 `index.html`。
3. 确保浏览器可以访问 Supabase CDN 和 Google Fonts。
4. 使用已经在 Supabase 中创建并绑定角色的 Connie/Jaco 账号登录。

也可以使用任意静态服务器运行，例如 VS Code Live Server、Vercel CLI 或其他本地 HTTP server。

## Supabase 配置

前端当前在 `app.js` 中直接读取：

```js
const SUPABASE_URL = '...';
const SUPABASE_KEY = '...';
```

如果复用这个项目，需要替换成自己的 Supabase project URL 和 publishable key。publishable key 可以暴露在浏览器端，真正的权限边界由 RLS 策略控制。

完整配置流程：

1. 在 Supabase 创建项目。
2. 创建 Connie 和 Jaco 两个 Auth 用户。
3. 创建 `profiles`、`tasks`、`notes`、`score_adjustments` 表。
4. 在 `profiles` 中写入两个用户的角色。
5. 执行 [supabase/rls.sql](supabase/rls.sql)。
6. 按 [docs/supabase-setup.md](docs/supabase-setup.md) 的 Smoke Test 验证 Connie 提交和 Jaco 审核流程。

## 部署

项目可以作为静态站点部署到 Vercel：

1. 将仓库导入 Vercel。
2. Framework Preset 选择 `Other` 或保持静态默认配置。
3. Build Command 留空。
4. Output Directory 留空或使用项目根目录。
5. 部署完成后，用 Connie/Jaco 账号测试登录、上传、审核和实时同步。

## 安全说明

- 浏览器端只使用 Supabase publishable key。
- 所有核心权限依赖 Supabase RLS，而不是前端按钮隐藏。
- Connie 只能提交或替换 `pending/rejected` 任务，不能从浏览器修改已通过任务。
- Jaco 可以审核、撤销通过、为过期任务开放补交、删除 Connie 自定义任务、创建或删除手动调分记录。
- `proofs` bucket 当前是 public，因为前端会保存公开图片 URL。
- 如果未来证明图片需要隐私保护，应改为私有 bucket，并在前端使用 signed URL。

## 当前限制

- `notes.content` 目前用 `|||` 同时保存双方留言；更理想的结构是拆成 `jaco_note` 和 `connie_message` 两列。
- Supabase URL 和 publishable key 目前写在 `app.js` 中；多人复用时建议改成部署环境变量注入。
- 当前是单 Connie、单 Jaco 的监督模式；如果要支持多学生，需要给 `tasks`、`notes`、`score_adjustments` 增加 owner/student 维度。
- 提交证明图片目前保存 public URL；隐私要求更高时需要迁移到 signed URL。

## 后续可优化

- 增加 README 截图或 GIF，展示 Connie 端和 Jaco 端界面。
- 将备注表拆字段，移除 `|||` 分隔符。
- 增加任务模板配置，让任务名称、频率和分值可在数据库中维护。
- 增加月度统计、连续打卡排行榜或导出功能。
- 增加更细的上传进度和失败重试提示。

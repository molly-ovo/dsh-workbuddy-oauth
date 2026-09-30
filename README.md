# dsh-workbuddy-standalone

把 WorkBuddy 的模型接入 DeepSeek Harness 的 DSH 插件。

与 [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) 的**根本区别**：本插件走**自己的 OAuth 设备码登录**，不读取 WorkBuddy 桌面 App 的凭据文件。

> **接手本项目？先读 [`HANDOFF.md`](./HANDOFF.md)。**
> 里面有当前状态、已犯过的错、实测过的接口、排查手册与铁律。
>
> 文档地图：
> - [`HANDOFF.md`](./HANDOFF.md) —— **交接（先读这个）**
> - [`PHASES.md`](./PHASES.md) —— 阶段设计、验收标准、教训记录
> - [`REUSE.md`](./REUSE.md) —— 可复用性审计
> - [`RISK-CONTROL.md`](./RISK-CONTROL.md) —— 防风控设计依据
> - [`PHASES-旧对话的phase.md`](./PHASES-旧对话的phase.md) —— 立项时的原始计划（对照用）

---

## 为什么另做一个

connect 复用桌面 App 的登录态，因此必须：

- 从磁盘找到 App 的凭据文件；
- 调用 App 的 Electron 二进制**解密**它（`desktop-credential-protection.ts`，**50 KB**）；
- 跟踪 App 的加密格式变化（5.6 起改成 `$wbEncrypted` 信封，上游多个同类项目因此失效）；
- 依赖桌面 App 的版本号与 UA 作为出站身份。

走自己的 OAuth 之后，上面四项**全部不再需要**。

| | connect | 本插件 |
|---|---|---|
| 凭据来源 | 桌面 App 文件（读 + 解密） | **自己的 OAuth** |
| 需要装桌面 App | ✅ 必须 | ❌ 不需要 |
| 凭据解密代码 | ~50 KB | **0** |
| 上游改加密格式 | 会失效 | 不受影响 |
| 多账号 | ❌ 单账号 | ✅ 每账号一份凭据（Phase 2） |
| 常驻进程 | 无 | **无** |

---

## 状态：P1 结构完成 / 端到端未验证

> **重要**：P1 只声明**结构**达成。本插件原定的验收标准是「**卸载桌面端后仍能正常对话**」，该条**目前不成立**——因为登录还没有界面入口，端到端链路走不通。功能验收已移交 P2，详见 [`PHASES.md`](./PHASES.md)。

已实现：

| 模块 | 说明 |
|---|---|
| `src/region.ts` | 国内版 / 国际版端点表 |
| `src/oauth.ts` | OAuth 设备码登录（begin → 授权 → poll → account），含 TTL 与轮询限速 |
| `src/credentials.ts` | 凭据存储（每账号一文件，原子写，0600） |
| `src/refresh.ts` | 令牌刷新（单飞 + 跨进程锁 + 惰性触发） |
| `src/fingerprint.ts` | 设备指纹按 uid 稳定派生 |
| `src/identity.ts` | 出站身份：**配置驱动**，不读桌面端 |
| `src/store.ts` | 凭据选择（轮转选号 + 失败冷却 + 会话粘性） |
| `src/account-state.ts` | 账号启用 / 停用状态（独立落盘） |
| `src/upstream.ts` | 上游 HTTP 客户端（SSE、目录、积分）—— 移植自 connect |
| `src/shim.ts` | 回环 OpenAI 兼容端点 —— 移植自 connect；含失败冷却 |
| `src/adapter.ts` | pi-ai provider 适配 —— 移植自 connect |
| `src/catalog.ts` | 模型目录 —— 移植自 connect |
| `src/index.ts` | 插件装配 + provider 注册 + 路由挂载 |
| `src/commands.ts` | `/wb-login` `/wb-status` `/wb-logout` `/wb-account` |
| `src/probe-service.ts` | 推理档位探测编排（队列 + 授权 + 账号重查） |
| `src/status-paths.ts` `src/web-status.ts` `src/control-route.ts` | 状态文档 + 控制路由（回环 + 进程内 key） |
| `src/client/` | 设置页卡片 + composer 探测控件（客户端 bundle） |

结构验证：`tsc`（host + client）零错误；**195 个测试全部通过**；`tsdown` 构建产出 `lib/index.js`（188 KB）+ `lib/client.js`（33 KB）。

防风控设计见 [`RISK-CONTROL.md`](./RISK-CONTROL.md) —— 对照同类项目的实测结论，说明每条规则借鉴自哪里。

阶段划分、验收标准与当前进度见 [`PHASES.md`](./PHASES.md)。

## 用法

登录（不需要桌面 App）：

```
/wb-login [cn | global]
```

命令会弹出一个确认框，里面**直接带可点的授权链接**——在浏览器完成授权后选「已完成授权，继续」即可，无需复制链接或重跑命令。

其它命令：

| 命令 | 作用 |
|---|---|
| `/wb-status` | 查看已登录账号、区域、令牌有效期 |
| `/wb-logout [uid 前缀]` | 退出登录（只删本插件保存的凭据，不动上游账号） |

**下一步（P2 剩余）**：设置页卡片 + 端到端验证。

---

## 目录

```
src/
  region.ts        区域定义（cn / global）
  oauth.ts         设备码登录
  credentials.ts   凭据存储
  refresh.ts       令牌刷新
  fingerprint.ts   设备指纹
  identity.ts      出站身份（配置驱动）
  store.ts         凭据选择接缝
  upstream.ts      上游客户端（移植）
  shim.ts          回环端点（移植）
  adapter.ts       provider 适配（移植）
  catalog.ts       模型目录（移植）
  commands.ts      斜杠命令（/wb-login 等）
  probe.ts         档位探测
  probe-store.ts  探测记录
  loopback.ts     回环判定
  index.ts         插件入口
tests/
  oauth.spec.ts          (22)
  commands.spec.ts       (22)
  refresh.spec.ts        (17)
  credentials.spec.ts    (13)
  fingerprint.spec.ts    (11)
  store.spec.ts          (11)
.upstream/         上游参照 clone（只读，已 gitignore）
REUSE.md           可复用性审计
RISK-CONTROL.md    防风控设计依据
```

---

## 开发

```powershell
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

### 验证要求（不要跳过）

`tests/index.spec.ts` 直接驱动 `apply()`。**这不是可选的覆盖面**——本插件装上后曾因装配顺序错误而完全无法激活（详见 [`PHASES.md`](./PHASES.md) 的教训 L1）。

| 层次 | 是否足够 |
|---|---|
| `tsc` 通过 | ❌ 不足够（类型宽松，装配顺序错误也能通过） |
| `import` 能加载 | ❌ 不足够（**假阳性**：模块能解析不代表 `apply` 能执行） |
| `apply()` 不抛错 | ✅ 最低要求 |
| 真实登录 + 一次对话 | ✅ 最终验收（需真实账号） |

**改动 `src/index.ts` 后必须跑 `pnpm test`。**

### 依赖说明

`@deepseek-ai/*` 与 `@earendil-works/*` 在公共 npm 上**存在但版本线冗长**，因此 `package.json` 把版本**钉死在 `0.2.0-rc.1`** —— 与当前运行的 DSH Desktop 核心（`dsh-plugin-desktop@2.0.16` / `@deepseek-ai/dsh@0.2.0-rc.1`）严格一致。

`pnpm install` 默认会解析到更新的 `rc.2`，**不要放开这个钉死**：pi-ai 适配层的类型在 rc 之间有过变动，放开会让「编译通过」失去意义。

---

## 设计约束

1. **不读桌面端任何文件。** 这是本插件存在的理由。
2. **不引入常驻进程。** 不做网关子进程 —— 那是 `dsh-workbuddy2api` 的路线，代价是多一个进程、一个端口、一层序列化。
3. **复用 DSH 内置能力。** 调度用 `dsh-schedule`，设置用 `dsh-settings`，别自己写。
4. **区域是一等概念。** 国内版与国际版是两套账号体系、额度互不通用，不能写死一个。
5. **多账号是既定目标。** 因此设备指纹隔离（`fingerprint.ts`）是必要能力，不是可选项。

---

## 非目标

以下内容**经评估后决定不做**，理由如下（避免将来被当作遗漏的需求重新提出）：

| 不做 | 理由 |
|---|---|
| 独立网关进程 | 回环端点在**进程内**；外部网关要多一个进程、一个端口、一层序列化 |
| Docker / Redis | 单机自用不需要，会引入常驻依赖 |
| Responses API（Codex） | DSH 用不到 |
| Anthropic Messages 协议 | 同上 |
| 对外 Web 管理面板 | DSH 的设置页就是面板 |
| 对外暴露 HTTP 端口 | 无此需求；回环端点只绑 `127.0.0.1` |
| 会话复制 / 账号切换 | 那是 switch 类工具（如 `changexbc/workbuddy-switch`）的领域 |

完整清单与阶段划分见 [`PHASES.md`](./PHASES.md)。

---

## 许可

MIT

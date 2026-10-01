# dsh-workbuddy-standalone

把 WorkBuddy / CodeBuddy 的模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，**自带 OAuth 设备码登录**——不读取桌面 App 的凭据文件，也不需要安装桌面 App。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![tests](https://img.shields.io/badge/tests-245%20passing-brightgreen.svg)
![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-green.svg)

---

## 特性

| 能力 | 说明 |
|---|---|
| **自有 OAuth 登录** | 国内版 / 国际版各一套端点，走设备码流程；不依赖桌面 App |
| **多账号** | 每账号一份凭据，轮转选号、失败冷却、会话粘性 |
| **账号管理** | 启用 / 停用 / 登出，命令与设置页都能操作 |
| **模型显隐** | 可逆，按区域持久化；附带上下文窗口开关 |
| **推理档位探测** | 手动探测某模型实际接受的档位 |
| **积分余额** | 设置页查询总积分 |
| **双界面** | 设置页卡片 + composer 输入区探测控件 |

---

## 技术路线

本插件的定位是**不依赖桌面 App**。同类方案的凭据来源主要有三种：

| 路线 | 凭据来源 | 需要桌面 App | 代表实现 |
|---|---|---|---|
| **本项目** | 自己的 OAuth 设备码流程 | 不需要 | — |
| 读桌面凭据 | 桌面 App 的本地文件 | 需要 | [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) |
| 外部代理进程 | 本地网关进程 | 视实现而定 | `workbuddy2api` 系（如 [tearslee/dsh-workbuddy2api](https://github.com/tearslee/dsh-workbuddy2api)） |

选择自有 OAuth 的代价是要自己维护登录流程；换来的是不依赖桌面端的安装位置、凭据加密格式与版本号。

上游协议与若干模块移植自 `dsh-workbuddy-connect`（MIT），出处与许可见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

---

## 安装

### 前置条件

- DeepSeek Harness（本项目按 `@deepseek-ai/*@0.2.0-rc.1` 编译与测试）
- Node.js `^22.19.0 || >=24.0.0`
- 一个 WorkBuddy / CodeBuddy 账号（国内版或国际版均可）

### 从本地路径安装

```powershell
dsh plugin --profile desktop add D:\Code\dsh-workbuddy-standalone
```

该命令会把包加入 profile 依赖，并因其声明了 `dsh.bundle` 而自动追加到 bundle 层栈。**装完需刷新或重启 GUI**：模型 provider 目录在进程启动时组成。

手动安装（等价做法）：

1. 在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 加入
   `"dsh-workbuddy-standalone": "link:D:/Code/dsh-workbuddy-standalone"`
2. 把 `dsh-workbuddy-standalone` 追加到同文件 `dsh.profile.bundles` 数组末尾
3. 在该 profile 目录执行 `pnpm install`
4. 重启 DSH

### 确认已生效

插件激活后运行 `/wb-status` 应有输出。若没有，检查该 profile 的插件行是否 `enabled`，以及 `llm-workbuddy-standalone` 是否已注册。

---

## 用法

### 登录

```
/wb-login [cn | global]
```

命令会弹出确认框，其中**直接给出可点击的授权链接**。在浏览器完成授权后，选「已完成授权，继续」即可——不需要复制链接，也不需要重跑命令。

### 命令

| 命令 | 作用 |
|---|---|
| `/wb-login [cn \| global]` | 登录（默认 `cn`） |
| `/wb-status` | 查看已登录账号、区域、令牌有效期 |
| `/wb-account [enable\|disable] <uid 前缀>` | 启用 / 停用账号 |
| `/wb-logout [uid 前缀]` | 退出登录（只删本插件保存的凭据，不动上游账号） |

### 设置页

登录、状态、账号管理与积分查询也可在 **设置 → 插件 → DSH WorkBuddy Standalone** 卡片中完成。composer 输入区右侧另有一个探测控件，用于探测当前模型的推理档位。

> 探测会向上游发出真实请求并消耗少量积分，因此有二次确认。

---

## 工作原理

```
DSH 模型选择器
  └─ pi-ai adapter（注册 provider route）
       └─ 回环端点  127.0.0.1，进程内，带一次性共享密钥
            └─ 上游  copilot.tencent.com / www.workbuddy.ai 等
```

- **无常驻进程、无对外端口。** 回环端点在本插件进程内，只绑 `127.0.0.1`，并校验进程内生成的共享密钥。
- **凭据每账号一文件**，原子写入，权限 `0600`。
- **令牌刷新惰性触发**（过期前 5 分钟），进程内单飞 + 跨进程文件锁——上游会轮换 refresh token，并发刷新会让第二个请求送出已被消费的令牌。
- **设备指纹按 uid 稳定派生**，同账号恒定、跨账号隔离；登录流程**不带**指纹。

---

## 隐私

### 显示时脱敏

账号昵称在上游常常就是手机号或邮箱。所有会显示昵称的地方（`/wb-status`、`/wb-account`、设置页卡片、状态文档）都经过同一层脱敏：

| 类型 | 原始 | 显示 |
|---|---|---|
| 手机号 | `13800138000` | `13*******00` |
| 邮箱 | `alice@example.com` | `a****@example.com` |

手机号只保留前 2 位与末 2 位（11 位中隐藏 7 位）；邮箱只保留本地部分首字符与域名。

脱敏**只作用于显示**：凭据文件里保留原始值，功能不受影响。日志里只记录 uid 的前 8 位，从不记录昵称。

### 登出会删掉什么

`/wb-logout`（以及设置页的「登出」）会清除该账号的**全部**痕迹，而不只是凭据文件：

| 位置 | 内容 |
|---|---|
| `accounts/workbuddy-<uid>.json` | 访问令牌、刷新令牌、昵称、企业 id |
| `cooldowns.json` | 该账号的失败冷却记录 |
| `disabled-accounts.json` | 该账号的启用 / 停用状态 |
| `probe-<region>.json` | 该账号的推理档位探测记录 |

这四类都以 uid 为键，只删凭据会让 uid 继续留在其余文件里——既是隐私问题（uid 是账号标识），也会在同一个账号再次登录时让旧的停用状态或探测结论悄悄生效。

所有状态都在 `$DSH_HOME/workbuddy-standalone/` 下，删除该目录即可完全重置。

> 注：`/wb-account disable` 是**可逆**的，只把账号移出选择，凭据与状态都保留；只有登出才会删除。

---

## 配置

插件行接受以下配置（在 profile 的 `cordis.patch.yml` 中设置）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `region` | `cn` | 默认区域，`cn` 或 `global` |
| `appVersion` | `""` | 出站身份中的客户端版本号，留空用内置兜底值 |
| `cliVersion` | `""` | 出站身份中的 CLI 版本号，留空用内置兜底值 |

---

## 已知限制

- **依赖上游非公开接口。** WorkBuddy / CodeBuddy 更新后，本插件可能需要随之调整。
- **推理档位需手动探测。** 上游未提供档位元数据，只能靠实际请求试出来；探测会消耗积分。
- **国际版与国内版是两套账号体系**，额度互不通用，需分别登录。
- **模型目录随上游变化**，本地缓存可能滞后。
- **失败换号要等到下一次请求。** 某账号被限流或额度耗尽时，**当前这次请求仍会返回错误**；该账号被冷却后，**下一次请求**才会自动落到另一个可用账号上。

  插件**不做请求内重试**：流式响应一旦开始就无法透明重发，且同一个请求体换账号重发会放大上游风控风险。DSH 自身的重试层在重试时会重新走一遍选号，所以实际体验通常是「偶发一次报错后自动恢复」。

  同一个对话也不例外——会话粘性**不会**把你钉在坏账号上，下一条消息就会换到健康账号，上下文不丢（消息由 DSH 持有，不在账号上）。

- **「最大上下文窗口」开关只影响国际版。** 国内版没有任何模型声明多档窗口，因此该开关只在国际版标签页出现；国内版页面会说明这一点，而不是给一个点了没反应的控件。

---

## 免责声明

- 本项目**仅供个人学习与研究使用**，仅驱动使用者自己的账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy / CodeBuddy 的服务条款。因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），**由使用者自行承担**。
- 本项目与腾讯、WorkBuddy、CodeBuddy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，商标权利归各自所有。
- 本项目作者不对因使用或滥用本项目产生的任何直接或间接损失负责。

---

## 许可

MIT，见 [LICENSE](./LICENSE)。

本插件移植/改写自若干开源项目，逐模块的出处、重合度与各项目许可见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

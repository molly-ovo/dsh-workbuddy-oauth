# dsh-workbuddy-standalone

把 WorkBuddy / CodeBuddy 的模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，**自带 OAuth 设备码登录**——不读取桌面 App 的凭据文件，也不需要安装桌面 App。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![tests](https://img.shields.io/badge/tests-259%20passing-brightgreen.svg)
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

上游协议与若干模块移植自 `dsh-workbuddy-connect`（MIT），详见下方[鸣谢](#鸣谢)。

### 关于 fork

需要说明的是，本插件**没有** fork `dsh-workbuddy-connect`，而是把它需要的模块移植（vendor）进来。

主要原因是两者的取舍不同：connect 复用桌面 App 的凭据文件，本插件改为自己走 OAuth 设备码流程。改动集中在凭据来源这一层，但会牵动登录、刷新、状态落盘等多处，**改到后来已经不太像同一个项目**。

另一个考虑是我自己的：**fork 在 GitHub 上是一种公开的关联**，会出现在上游的 fork 列表里。我的这种做法上游作者未必认同，**不想因为自己的选择给他添麻烦**，所以没有走 fork。

这样做的代价是**上游后续的修复不会自动进来**，需要自己留意（见下方「跟进上游」）。另外，移植部分的出处与重合度都逐文件标注在 [鸣谢](#鸣谢) 中，`LICENSE` 也声明了本项目包含来自其他 MIT 项目的代码——如果其中有任何不妥，欢迎指出，我会调整。

### 跟进上游

本仓库没有配置 `upstream` remote。想对比上游改动时可以临时加一个**只读**远程：

```sh
git remote add upstream https://github.com/corrinehu/dsh-workbuddy-connect.git
git fetch upstream
git diff upstream/main -- src/upstream.ts
```

只用来查看差异、手动挑拣，不推送。

---

## 安装

前置：`pnpm` 在 `PATH` 上、Node.js `^22.19.0 || >=24.0.0`，以及一个 WorkBuddy / CodeBuddy 账号（国内版或国际版均可）。**不需要安装桌面 App**——登录由本插件自己走 OAuth 设备码流程完成。

**版本对应**：本插件在 **`0.2.0-rc.1`** 上开发与测试。

```sh
# 安装（profile 一般是 web）
dsh plugin --profile web add dsh-workbuddy-standalone
dsh web
```

`dsh plugin` 会把参数转发给 pnpm 在 profile 目录里执行，成功后**自动对账 `dsh.profile.bundles`**——本插件声明了 `dsh.bundle.patch`，装上即接管模型目录，无需手改 profile 文件。`web` profile 首次使用时自动从模板初始化。

**装完刷新浏览器**。模型 provider 目录在进程启动时组成；若模型没出现，重启 `dsh web`。

登录：卡片顶部「登录 · 国内版 / 国际版」→ 浏览器完成授权 → 回卡片点「我已完成授权」。也可以直接用 `/wb-login`，两条路径走的是同一套实现。

另外，输入框右侧的模型选择器旁有一个**推理档位检测**控件，仅对声明了多档位的模型出现；检测会发出真实请求并消耗少量积分。

### 确认已生效

```sh
/wb-status
```

应有输出。若没有：确认该 profile 的插件行 `enabled`、`llm-workbuddy-standalone` 已注册，并检查「插件」页是否能看到本条目。

### 从本地源码安装（二次开发用）

**注意：本仓库不包含可直接安装的产物。** 源码在 `src/`，`lib/` 是 `pnpm build` 的输出目录，已被 `.gitignore` 忽略——所以 clone 下来只有 TypeScript 源码，没有 `lib/index.js` 和 `lib/client.js`。这不是漏提交，而是有意为之：构建产物由源码决定，提交它只会带来「改了源码忘了重新构建」的假象，让 profile 实际加载的版本与仓库里看到的不一致。

因此从源码安装需要先构建：

```sh
cd /path/to/dsh-workbuddy-standalone
pnpm install
pnpm build                          # 生成 lib/index.js 与 lib/client.js
dsh plugin --profile web add .      # "." 锚定当前目录，也可用绝对路径
```

pnpm 对本地目录默认以**链接**方式安装，所以之后重新 `pnpm build`，profile 会即时拿到新产物。改完客户端半边刷新浏览器即可；改动宿主半边（`lib/index.js`）需要重启 `dsh web`。

### 卸载

```sh
dsh plugin --profile web remove dsh-workbuddy-standalone
```

账号凭据与插件状态都在 `$DSH_HOME/workbuddy-standalone/` 下，**卸载不会删除**；要彻底清理请手动删该目录（见[隐私](#隐私)）。

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

- 本项目**仅供个人逆向学习与技术研究使用**，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守任一官方的服务条款，并自行承担因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断）。
- 本插件只使用你自行登录后获得的令牌，不收集、不上传任何凭据到第三方服务器。
- 本项目与任一官方均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，商标权利归各自所有。
- 本项目作者不对因使用或滥用本项目产生的任何直接或间接损失负责。
- **本项目由 AI 参与移植与改写**，可能存在缺陷，请自行评估风险。若无意侵犯任一上游项目或第三方的权益，请联系我，我会**立即删除或调整**相关内容。

---

## 鸣谢

本插件站在若干开源项目的肩膀上。以下项目或提供了被移植的代码，或提供了关键的对照实现与线路行为参考——**没有它们，这个插件不会存在**。

### 代码来源

| 项目 | 作者 | 本插件使用了什么 |
|---|---|---|
| [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | Corrine Hu | **最主要的上游。**核心模块直接移植自此上游。 |
| [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) | Sliverkiss | 设备指纹派生算法 `derive_id`；线路行为经 connect 间接源自此项目。 |
| [workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | ardeyouxipianyi | 指纹方案的实测依据；登录流程、刷新单飞、惰性刷新等防风控规则的对照实现 |
| [workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | linguo2625469（fork） | 登录状态落盘防混域、登录 TTL 与轮询限速等对照实现 |

> 关于 `Sliverkiss/workbuddy2api`：该上游项目已删除。

### 特别感谢

- **Corrine Hu** —— `dsh-workbuddy-connect` 是这一切的起点。本插件与它的差别只在于**去掉桌面端凭据解密**（`desktop-credential-protection.ts` 未被使用），其余绝大部分逻辑都源于它的实现与逆向工作。
- **Sliverkiss** —— `workbuddy2api` 系列对上游接口的整理与指纹方案，是本插件能与 WorkBuddy 通信的前提。
- **ardeyouxipianyi** —— `workbuddy2api-hub` 提供的指纹实测依据与防风控对照实现，让选号与刷新策略有据可循，而不是靠猜。

### 依赖的开源软件

本插件运行在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 之上，并依赖其客户端插件体系（`@deepseek-ai/dsh`）。设置卡片的按钮交互样式对齐了 DSH 自带的 `dsh-client-ui-primitives`，主题色全部使用其 `--dsw-alias-*` 令牌。

---

## 许可

MIT，见 [LICENSE](./LICENSE)。

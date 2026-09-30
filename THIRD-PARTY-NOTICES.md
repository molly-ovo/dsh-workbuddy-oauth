# 第三方来源与许可声明

本插件（`dsh-workbuddy-standalone`）的若干模块**移植或改写自以下开源项目**。各项目的版权归其作者所有，其许可条款适用于对应部分的代码。本文件按 MIT 的要求，随本软件一并保留原始版权声明与许可声明。

---

## 1. dsh-workbuddy-connect —— MIT

- 仓库：<https://github.com/corrinehu/dsh-workbuddy-connect>
- 参照版本：`0.6.5`
- 版权：Copyright (c) 2026 Corrine Hu

**被移植的模块**（重合度高，属"实质性部分"）：

| 本仓库文件 | 上游文件 | 与上游重合度 |
|---|---|---|
| `src/upstream.ts` | `src/upstream.ts` | ~98% |
| `src/shim.ts` | `src/shim.ts` | ~99% |
| `src/adapter.ts` | `src/adapter.ts` | ~96% |
| `src/catalog.ts` | `src/catalog.ts` | ~95% |
| `src/probe-service.ts` | `src/probe*.ts` | ~92% |

另有 `src/index.ts`、`src/status-paths.ts`、`src/web-status.ts`、`src/client/*` 等按上游结构改写（重合度 14%–49%）。上游的 `desktop-credential-protection.ts`（解密桌面端凭据）**未使用**，那正是本插件要摆脱的依赖。

## 2. workbuddy2api —— MIT

- 仓库：<https://github.com/Sliverkiss/workbuddy2api>
- 版权：Copyright (c) 2026 Sliverkiss

**被使用的部分**：设备指纹派生算法 `derive_id`（`md5("<salt>:<uid>")` 截断），见 `src/fingerprint.ts`。`src/upstream.ts` 的线路行为经 connect 间接源自该项目。

> 注：核实本文件时该仓库返回 404（可能已改名、转私有或删除）。此处按 `linguo2625469/workbuddy2api-panel` 的 `LICENSE` 中记录的信息标注 —— 该 fork 明确写明原项目为 `Sliverkiss/workbuddy2api` 且采用 MIT。若原仓库日后恢复或改名，请以实际地址为准。

## 3. workbuddy2api-hub —— MIT

- 仓库：<https://github.com/ardeyouxipianyi/workbuddy2api-hub>
- 版权：Copyright (c) 2026（上游 `LICENSE` 未署具体姓名）

**被使用的部分**：作为 `derive_id` 指纹方案的实测依据，以及登录流程 / 刷新单飞 / 惰性刷新等防风控规则的对照实现。

## 4. workbuddy2api-panel —— MIT

- 仓库：<https://github.com/linguo2625469/workbuddy2api-panel>
- 版权：Copyright (c) 2026 Sliverkiss（原项目）／ Copyright (c) 2026 linguo2625469（本 fork）

**被使用的部分**：登录状态落盘带 realm 防混域、登录 TTL 与轮询限速等对照实现。

---

## MIT License（适用于上述各项）

以下许可文本适用于本文件中标注为 MIT 的各第三方项目，其版权分别归上文各项目的作者所有。

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

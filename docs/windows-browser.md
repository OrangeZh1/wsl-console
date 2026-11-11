# Linux driver 连接 Windows 浏览器

这个可选执行端组件适用于测试 driver 留在 WSL、浏览器需要运行在同一物理设备 Windows 上的场景。工作台 HTTP 继续只读，不负责启动浏览器或派发任务。

`scripts/windows-browser.mjs` 导出 `connectWindowsBrowser()`。它通过一次 WSL interop 启动 Windows Node，再用标准输入、标准输出传输原始 TCP 字节。Windows Playwright browser-server 和 Linux 单连接代理都只绑定 `127.0.0.1`，不需要 LAN 监听、端口转发或防火墙修改。

使用的是完整 Playwright 协议。官方 [`launchServer()` / `connect()` 文档](https://playwright.dev/docs/api/class-browsertype#browser-type-connect)要求客户端与服务端的 major/minor 版本一致；这个组件固定并验证 Windows Playwright `1.64.1`，调用方也应使用 `1.64.1`。`connect({ exposeNetwork: '<loopback>' })` 使浏览器可以访问 Linux driver 侧的 loopback HTTP 服务。

## 隔离安装

默认工具目录如下。脚本不会自动下载、修改全局 PATH、修改用户浏览器 profile 或设置开机启动。

| 位置 | 内容 |
| --- | --- |
| `D:/WSL/tools/windows-browser-1.64.1/node-v24.18.0-win-x64/` | 官方便携 Windows Node |
| `D:/WSL/tools/windows-browser-1.64.1/playwright/` | 独立 Playwright `1.64.1` npm 安装 |
| `D:/WSL/tools/windows-browser-1.64.1/browsers/` | 该版本的官方 Windows 浏览器 |
| `D:/WSL/tools/windows-browser-1.64.1/src/windows-browser-server-chromium.cjs` | 本仓库的 Windows server 源码 |
| `D:/WSL/state/browser-sessions/pw-<UUID>/` | 每次调用独立的 Windows 临时状态及 server receipt |

先从 [Node 官方 v24.18.0 分发目录](https://nodejs.org/dist/v24.18.0/)下载 `node-v24.18.0-win-x64.zip`，用同目录的 `SHASUMS256.txt` 核对 SHA-256，再解压到上表目录。随后在 Windows 执行：

```powershell
$root = 'D:\WSL\tools\windows-browser-1.64.1'
$node = "$root\node-v24.18.0-win-x64\node.exe"
$npm = "$root\node-v24.18.0-win-x64\node_modules\npm\bin\npm-cli.js"
$env:PLAYWRIGHT_BROWSERS_PATH = "$root\browsers"
& $node $npm install --prefix "$root\playwright" --no-audit --no-fund playwright@1.64.1
& $node "$root\playwright\node_modules\playwright\cli.js" install chromium
New-Item -ItemType Directory -Force -Path "$root\src" | Out-Null
Copy-Item -LiteralPath 'scripts\windows-browser-server.cjs' `
  -Destination "$root\src\windows-browser-server-chromium.cjs"
```

`scripts/windows-browser-server.cjs` 的仓库文件名与安装文件名不同；内容应保持原始字节。Linux 入口在启动 interop 前核对这份 Windows 源码的 SHA-256。修改 Windows 源码时，必须同步入口内的 source hash，并重新验证组件，不能直接覆盖已验证安装。

Linux 端只需要把 `scripts/windows-browser.mjs` 安装到 ext4 下的明确工具目录，例如 `$HOME/.local/share/wsl-console/windows-browser-1.64.1/windows-browser.mjs`。调用方自己的隔离工程提供 `playwright@1.64.1`，组件没有新增常驻 npm 依赖。

## 调用与收尾

调用方执行器应先取得该物理设备的统一重任务锁及资源准入，并在浏览器整个生命周期内沿用同一个 Windows 文件资源 reader 和 Linux 低水位监控。锁保持到 `close()` 完成；组件不会另取第二把锁或另起一个 sampler。

```js
import {createRequire} from 'node:module';
import {connectWindowsBrowser} from '/absolute/ext4/tool/windows-browser.mjs';

const require = createRequire(import.meta.url);
const handle = await connectWindowsBrowser({playwright: require('playwright')});
try {
  const browser = handle.browser;
  // 原有 context 配置、页面操作、截图、键盘和断言继续使用正常 Playwright API。
} finally {
  await handle.close();
}
```

这不是设置环境变量就会自动替换浏览器的机制。调用方需要在自己的测试 harness 中显式接入创建浏览器的位置，保留原有 context、正常操作及断言。应用源码不需要接入这个组件。

仅支持以下入口参数：

| 参数 | 含义 |
| --- | --- |
| `playwright` | 调用方已安装的 Playwright 对象 |
| `timeout` | 建立 Windows server 和连接的超时，默认 `40000` 毫秒 |
| `onEvent` | 可选的本次 server 生命周期事件回调 |

未知参数会被拒绝，包括 `launchOptions`、`args`、`channel` 和 `headless`。当前 server 固定为官方 bundled Chromium、headless 模式。已有 launch 配置需要调用方明确评估，不能静默丢弃；`browser.newContext(options)` 的配置仍由调用方正常传入。

返回值包含 `browser`、`close()` 和本次 `receipt`。receipt 包括实际浏览器版本、两侧临时端口、Windows 进程及独立会话路径。连接断开后 server 关闭自己拥有的浏览器；`close()` 等待代理及 Windows Node 退出。关闭超时应作为执行器失败或待核实状态保留，不能写成收尾通过。

`onEvent` 中的 WebSocket endpoint 属于本次临时控制入口，不应放到公开报告。正式安装 receipt、实际设备状态、截图和进程/端口证据保留在执行器自己的私有证据目录，不写入这个公开仓库。

## 验证范围

`test/windows-browser.test.mjs` 使用实际 helper 源码、内存 streams 和模拟 process/net 边界，验证参数拒绝、版本/loopback 检查、双向原始字节转发与正常关闭。它不启动 Windows、WSL、监听端口或浏览器，适合 GitHub Actions 的单元测试。

真实环境验证应在执行端资源门禁和统一锁内完成：Linux loopback HTTP 页面可达、正常 `requestAnimationFrame`、普通点击及断言、键盘输入及断言、正常截图，以及进程和端口收尾。通过静态组件验证不等于业务测试通过；业务仍须运行完整的原有检查，保留失败记录。

# WSL Console

跨项目的本地验收工作台，展示项目、逻辑任务、每次运行及运行内阶段。浏览器与 HTTP 接口保持只读；命令执行、数据库和进程生命周期由各项目自己的验收脚本负责。

已实现执行／等待／历史筛选、多次运行记录、当前进展、增量日志、耗时、测试统计、源码版本及历史维护。工作台使用完整可视宽度，保留紧凑的任务导航、阶段列表和内部滚动。图标使用本地打包的 Iconify Lucide，页面运行不依赖图标 CDN，[来源与许可](docs/icon-attribution.md)随源码保留。v3 参考图未作为本轮重建目标，不声称对应像素验收。

## 手动启动

需要 Node.js 24 及以上，仅使用内置模块，无需安装 npm 依赖。克隆后在项目目录复制通用配置，并先按本机实际 WSL 发行版、普通用户、Node 位置及运行记录目录调整 `config.json`：

```powershell
Copy-Item config.example.json config.json
node start-wsl.mjs --no-browser
```

Windows 启动 WSL、core 和 LAN relay 时通过 `Start-Process -WindowStyle Hidden` 创建隐藏后台子进程，不弹出 CMD、PowerShell 或终端窗口；启动器退出后服务继续运行。保留手动启动，不设置开机自启，不使用 Windows 的 `detached: true` 新控制台模式。

Windows / WSL 场景优先使用该启动器：它确认或启动 WSL 内的 core，并为当前有效的物理私网 IPv4 提供同子网只读 LAN 入口，复用兼容的已有进程。以启动器实际输出的本机 URL 和 LAN URL 为准，不在源码写死 DHCP 地址。没有有效 LAN 时如实报告 local-only。浏览器由使用者或浏览器工具打开／复用；`--no-browser` 不通过 shell 操作浏览器，同一轮不反复新开标签。

本机 core 保持只监听 `127.0.0.1`；Windows relay 只绑定实查的物理私网 IPv4，接受同一实际子网，固定转发到本机 core。它不改防火墙、网络 profile 或 portproxy，不设开机自启，也不做公网映射。LAN 页面会显示项目日志，仅供受信私网；主机 HTTP 可达不能代替手机实测。配置、停止时的身份／任务保护与访问边界见 [局域网访问](docs/lan-access.md)。

按启动器记录核对归属后停止：

```powershell
node start-wsl.mjs --stop
```

已有共享后端和其他项目进程按归属保护，不全局关闭 WSL。`config.json`、真实任务记录、日志、私有数据和临时产物已忽略，不应上传到 Git。

仅需本机 core 或在其他已配置环境运行时，可以直接启动 Node：

```text
node server.mjs config.json
```

该入口只提供本机 loopback，不建立 Windows LAN relay；保持终端打开，Ctrl+C 停止。Linux 复制配置可用 `cp config.example.json config.json`。相对 `runsRoot` 从启动时的工作目录解析，因此应在项目目录启动；示例默认读取 `./.local/runs`，端口为 4399。

core 和 relay 的 HTTP 都只接受只读请求，保留 Host、路径与日志保护。页面和接口没有启动、停止、重跑、删除、修改配置、发布或部署任务的操作。

## 项目、任务、运行和阶段

同一项目可以有多个逻辑任务，一个逻辑任务可以保留多次运行，每次运行有独立阶段、命令、日志、版本和测试统计。

执行器应给同一逻辑任务使用稳定的 `taskKey`，每次运行使用新的唯一 `id`。未提供 `taskKey` 的历史记录仅在展示时按排序后的 `projects` 与 `name` 分组，不改写原记录。任务卡的“N 次记录”是当前保留的运行记录数；30 天维护会改变该数值，它不是全生命周期执行次数。

左侧执行、等待、历史三个按钮按逻辑任务计数：任务存在任一 running 记录则归执行，否则有 queued 记录则归等待，其余归历史与其他。真正同时运行的多条记录会显示并行数量。按钮只筛选，不执行任务。首次进入优先执行，其次等待，最后历史。

首次进入任务默认查看最新的活动记录，或最近一条记录。顶部运行记录列表只列出当前任务的各次运行，显示开始时间到秒和实际状态；旧失败及其日志保留，不会被成功重试覆盖。选择较早记录时，详情与当前进展只读取该次运行，并提示它与逻辑任务当前状态的关系。

切换类别会恢复该类别上次仍有效的任务、运行与阶段；空类别清除先前的阶段、命令、日志、版本和统计，显示明确空态。后台刷新保留当前筛选和选择，不跳到最新重试。当前运行自然结束时继续保留详情，并提示任务所属类别变化。

旧网络请求较晚返回也不会覆盖当前选择。只有手动点击刷新时，刷新按钮才显示加载状态；日志轮询不触发该按钮。长任务名单行省略，原生提示与可访问名称保留完整信息。

日志栏的“刷新日志”会从头重新读取当前所选运行与阶段的日志，不刷新任务状态或切换选择。读取期间只显示该按钮的加载状态，失败时保留已有日志；“跟随最新日志”保持原设置，关闭跟随时保留当前滚动位置。排队或未选择阶段时不可刷新。

顶部的只读资源摘要每 5 秒采样 WSL 内存已用／可用／总量、Swap 和 CPU 一分钟负载／逻辑核数，并显示采样时间。内存可用量使用 Linux `/proc/meminfo` 的 `MemAvailable`，不会把可回收缓存全算作内存压力；读取失败或平台不支持时显示未知。CPU 负载不是使用率百分比，任务数量也不代表重负载进程数量；资源协调仍由各项目执行器负责。

该摘要只反映 WSL，不代表 Windows 宿主机整体空闲。执行构建、数据库集成测试等重任务前，执行端还应核对 Windows 的可用物理内存，避免宿主机已紧张时继续叠加负载；查看器没有全局队列、资源预留或互斥机制。

## 执行端重任务准入

此节是各项目执行器必须落实的约定，不表示查看器已经提供调度器。页面与 HTTP 接口继续只读；既有进程不会因新增规则自动纳管，旧会话应重新读取规则。

- 所有项目的完整测试、类型检查、生产构建和数据库集成验收共用一个重任务名额，按阶段串行。统一使用 Linux `flock` 文件 `/home/qicore-qa/.local/state/wsl-progress/heavy-task.lock`；不得按项目分锁、删除文件抢锁、拆任务或另起 agent 绕过。锁应覆盖实际命令及其子进程生命周期，退出时释放；锁文件本身保留。每个执行器仍是自己 `run.json` 的唯一 writer。
- 拿锁前和开跑前，核对 Windows 可用物理内存、WSL `MemAvailable`、swap、负载及端口和进程归属。默认准入下限为宿主机 2.5GiB、WSL 2GiB；另按命令实测峰值留下宿主机至少 1GiB、WSL 至少 512MiB 余量。未知峰值先使用有界 heap 与 worker，不能用 swap 代替余量，也不能只看任务数量。未纳管的重命令仍在执行时，先按用户选择等待其自然完成或协调，不因拿到文件锁就宣称没有其他重负载。
- 等锁或等资源时上报 queued 和具体原因；真正拿到名额、通过资源准入并开始实际命令时再上报 running。执行端没有可靠位次就不填 `queuePosition`，不能根据页面排序推算。轻量读取、采样与准备工作可以并行；同一重阶段不叠加重复 checker，复用未变化内容的有效检查，不降低必要验证门禁。
- 重任务执行期间监测低水位。宿主机可用不足 1GiB 或 WSL 不足 512MiB 时，优先安全中断本任务拥有的重阶段，记录资源样本和真实中断状态，条件改善后保留原记录、使用新 run ID 重试；不停止其他项目的进程，不关闭共享查看器或整个 WSL。不要用固定高门槛无限等待，应记录具体预算与实测峰值。
- 为本任务的常驻开发预览、数据库和辅助进程记录 PID、精确归属、端口和当前用途；评审结束且已无使用需要时及时释放。其他任务的常驻服务不会自然退出；它阻挡准入时，应明确指出归属和影响，依用户选择处理，不能把它冒充会自行结束的有限命令。
- 执行器在 `try/finally`、信号与退出处理中写入真实终态并结束本次运行。浏览器检查也适用；等待、失败和资源中断不得写通过，不覆盖历史。需要持续保留的预览状态与已完成验收记录分开表达，不能用运行中的验收阶段代替常驻进程登记。

实际重命令必须在同一次持锁调用中执行，例如在项目的 Linux 副本内运行：

```text
flock --exclusive -- /home/qicore-qa/.local/state/wsl-progress/heavy-task.lock pnpm test
```

这只是执行端接入方式示例，调用者仍须完成上面的资源准入与真实上报；不能先执行一个立即退出的锁探测命令，再在锁外启动重任务。

## 当前进展

“当前进展”列出所选运行中所有实际 running 阶段，可跳到对应阶段日志。展示阶段名、执行端上报的 `activity`、开始时间、耗时，以及 `activityUpdatedAt` 或元数据更新时间。

没有细粒度上报时只显示阶段已有的 `detail`／`command`，并明确提示“暂无细粒度进展上报”，不从日志推测进度。运行中默认适度展开，小屏默认折叠，长内容内部滚动。排队、失败、成功和历史记录显示自身真实状态，不把旧动作冒充正在执行。

失败详情按所选运行列出所有失败阶段，优先展示执行端上报的错误，其次是对应失败阶段日志中的具体错误原文，并明确标注来源。日志摘录可展开，按钮只跳到该失败阶段的日志。即使当前选中成功阶段，也不会拿成功阶段的输出充当失败原因；未提供具体信息时会明确说明，不能据此推断根因。切换运行立即清除旧详情，较晚返回的请求也不会串入新记录。

## 手机查看

768px 及以下使用紧凑布局：任务导航默认收起，只保留真实分类计数和“任务”展开入口；展开后可切换其他任务，选择后收起。刷新不会自行改变展开状态。阶段改为原生选择器，提供完整阶段名称、实际状态和通过进度；桌面仍使用原阶段树。

手机不重复堆叠任务卡和阶段标题，给日志保留主要空间。日志在 390×844、500×1067 竖屏中至少保留 260px，可内部横向和纵向滚动。当前进展、失败详情和源码内容在正常文档流中展开，内容区至少可读三行并内部滚动，不遮住日志，也不改变所选任务、运行或阶段。

局域网 HTTP 页面没有现代剪贴板接口时，“复制日志”会在用户点击后尝试浏览器兼容复制；仅实际成功时显示“已复制”，失败则提示手动选择。复制保持自己的加载状态和所选记录校验，不读取系统剪贴板。

等待记录的入队时间与队列位置也只来自执行端；未提供位置时不按列表顺序生成位置。未开始的任务或阶段不显示开始时间、已用时、退出码或旧日志。

## 接入格式

`config.json` 的 `runsRoot` 下，每次运行创建一个唯一目录：

```text
<runsRoot>/<run-id>/run.json
<runsRoot>/<run-id>/logs/<step-id>.log
<runsRoot>/<run-id>/work/                 # 可选，托管临时工作目录
```

服务读取时发现新目录，无需重启。运行和阶段 ID 允许字母、数字、下划线和连字符，以字母或数字开头，最长 80 字符。`taskKey` 是非空且不超过 160 字符的稳定逻辑任务标识；它不替代每次运行的唯一 ID。

以下只是格式示例：

```json
{
  "format": "wsl-progress-v1",
  "id": "project-unique-run-id",
  "taskKey": "linux-build",
  "name": "Linux 构建验收",
  "projects": ["某项目"],
  "environment": "Ubuntu / WSL2",
  "status": "queued",
  "enqueuedAt": "2026-11-09T13:00:00Z",
  "queuePosition": 2,
  "updatedAt": "2026-11-09T13:00:00Z",
  "finished": false,
  "versions": [{"name":"某项目","branch":"main","head":"实际提交","sha256":"实际源码快照哈希"}],
  "steps": [{"id":"build","label":"构建","detail":"项目自身构建检查","status":"queued","command":["node","build.mjs"]}]
}
```

`status` 可取 `queued`、`running`、`passed`、`failed`、`blocked`、`cancelled`、`interrupted`。开始后填 `startedAt` 并移除 `queuePosition`；完成阶段填 `finishedAt`、`seconds`、实际 `exitCode` 和 `tests: {pass, fail, skipped}`。整次运行结束后填 `finished: true`、`finishedAt` 及实际最终状态。日期使用有效 ISO 8601，页面按 Asia/Shanghai 显示到秒。

一个 writer 拥有一份 run.json；多个并行阶段共用同一 reporter 串行写元数据，不让多个进程分别覆盖同一记录。写 JSON 时先写同目录临时文件，再原子 rename。日志使用 UTF-8 append；不得写入真实凭据、令牌、数据库密码或私钥。

## 上报 helper

已有项目执行器可导入本工具的 `reporter.mjs`，无需为接入查看器修改业务框架。下面展示上报调用；真实命令及其结果仍由项目执行器产生：

```javascript
import {createReporter} from '/path/to/wsl-console/reporter.mjs';
const reporter=await createReporter('/path/to/local-runs',{
  id:'project-unique-run-id', taskKey:'linux-build',
  name:'Linux 构建验收', projects:['某项目'],
  steps:[{id:'build',label:'构建'}]
});
// 可让项目执行器把源码副本、依赖和其他临时内容放到 reporter.workDirectory。
// 该属性是 <runsRoot>/<run-id>/work，目录由执行器按需创建。
await reporter.step('build',{status:'running',command:['node','build.mjs']});
await reporter.activity('build','正在核对构建入口');
// 把项目执行器的真实输出传给 reporter.log('build', text)。
// 退出后按实际结果报告 passed/failed、exitCode 和 tests，再调用 reporter.finish()。
```

`activity(id, message)` 只更新 running 阶段的当前动作与更新时间，不重置开始时间。`queue({queuePosition})` 只报告已知位置，不分配位置或安排执行。`finish()` 拒绝仍有 running/queued 阶段的运行；未执行阶段由执行器按事实标为 cancelled/blocked 等。成功阶段要求退出码 0 且没有失败测试。`snapshot()` 可读取最新记录。

同一阶段重复 `step(id, {status:'running', ...})` 视为进行中的进展更新，保留首次进入该阶段时的 `startedAt`；界面轮询、刷新状态和刷新日志都不改变计时起点。确实重新执行时优先创建同一 `taskKey` 的新运行 ID；兼容旧执行器在终态后重新进入 running 的情况，此时使用新的阶段起点，并将上次终态元数据保留在 `attempts`。正在运行的耗时按当前阶段起点持续计算，终态才使用已上报的固定耗时。

进程退出、心跳和中断判断由执行端负责上报。新重试应创建新运行 ID，并复用 `taskKey`；不要覆盖或删除先前失败记录。正式报告和需要长期保留的产物放在托管 `work` 之外，不能依赖临时工作目录长期留档。

执行器应在 `try/finally` 或退出处理中把已完成、失败或中断的阶段写入真实终态，并结束本次运行，避免浏览器检查等阶段实际结束后长期停留在 `running`。查看器不会把没有终态记录的进程自动判定为已完成。

`config.sources` 可接入旧格式或正式证据：每项提供 `id`、`progressFile`、`logsRoot`，可附 `name`、`projects`、`environment` 和 `manifestFile`。源码 manifest 的 `repositories` 提供分支、提交和快照哈希。正式外部材料始终保留。

## 历史与托管临时文件保留

以可靠的 `finishedAt` 计算，严格超过 30 天的已结束运行从列表、详情和日志接口过期隐藏。手动启动服务时检查一次，运行期间每小时检查；停止服务后不继续计时，下一次手动启动补查，不注册操作系统定时任务或自启。

可删除的范围仅是 `runsRoot/<run-id>` 内可靠的 `wsl-progress-v1` 自有记录、日志及固定 `work`：ID 匹配、完成状态与终态阶段一致，时间有效。成功运行的各阶段须 passed、退出码 0 且无失败测试，其 `work` 在下一次维护时清理，运行记录与日志继续保留。失败 `work` 用于排障，30 天后才随历史回收；`reporter.finish()` 不同步删除工作目录。

活动、排队、未结束、未来或无效时间、保护标记 `retain:true`／`protected:true`／`retention.keep:true`、非空 `recoveryRefs` 及其引用目标均保留。未知文件、未完成元数据写入、目录或元数据／日志／work 符号链接和越界情况也会保留，不扫描或删除任意外部 `temporaryPaths`。

`config.sources` 的正式证据文件始终不删；过期只影响查看器展示。最近一次维护写入 `runsRoot` 同级的单份 `retention-last.json`，包含运行状态、移除项、工作目录清理、保留项和错误；未知旧回执不会被覆盖，并会阻止自动删除。维护只防止同进程检查重叠，不宣称跨进程锁或调度能力。页面和 HTTP 不提供清理按钮或接口。

## 验证

```text
npm test
```

默认在 WSL 的 ext4 项目副本中执行本地检查。真实浏览器检查复用已有项目的 Playwright 和已安装的 Linux Chromium，不给本工具安装新依赖；必要的 Windows 针对性补验使用已安装的 Edge，无头浏览器。例如：

```text
node test/browser.check.mjs --playwright-root /path/to/project-with-playwright --output /tmp/wsl-console-browser-evidence
```

检查创建独立测试服务，覆盖逻辑任务重试记录、并行阶段进展、分类切换、延迟响应、失败日志、状态图标，以及 2040、1440、1280 和 390 像素视口。测试数据不写入实际任务；截图与报告放在 OS 临时目录或指定正式证据目录。

## 本机约定与执行边界

当前电脑固定安装目录为 `G:\WSL\Console`。手动使用既有 WSL 环境时：
每次开展 WSL 工作前，优先执行 `node G:/WSL/Console/start-wsl.mjs --no-browser`，由浏览器工具打开或复用实际输出的本机进度页；手机使用启动器实查的受信 LAN 地址。同一轮不反复新开标签，先登记真实任务和当前动作，再执行检查；没有有效LAN时报告local-only，不把打开页面或主机可达当作手机验收。

```powershell
node G:\WSL\Console\start-wsl.mjs --no-browser
```

本机 WSL 为 `Ubuntu-24.04`，虚拟磁盘在 `G:\WSL\Ubuntu-24.04\ext4.vhdx`，资源上限为 6GB 内存、4 个逻辑处理器和 4GB swap；安装记录见 `G:\WSL\setup\README.md`。业务验收使用普通用户和隔离状态，不复制业务库、真实私钥或授权回执。关闭 WSL 前先确认其他任务没有依赖，不能因本工具结束而停止别的项目。

各项目执行器负责命令、端口、资源隔离和进程生命周期。查看器不能自动识别未上报的 WSL 进程或其他聊天，也没有全局占用锁、资源预留或排队执行协议。看到运行记录不代表其他任务已被禁止启动。

本工具测试与业务项目验收分别统计。所有项目的 CI、测试与构建默认使用本机 Ubuntu WSL，不例行提议或触发远端 CI，仅用户当次明确要求才例外。同范围修复与重跑继续完成；本地无法复现的检查如实列缺口，不伪造 GitHub 检查状态、不跳过实际检查、不降低门禁。正式发行签发、部署、真实交易和分支保护仍按原信任机制与授权执行。

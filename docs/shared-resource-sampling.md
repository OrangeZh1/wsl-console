# 共享 Windows 文件采样接口

这个接口由独立 Windows PowerShell 进程采样，Linux 验收执行器只读 JSON 与自己的 `/proc/meminfo`。它不调用工作台 HTTP，也不从 WSL 周期性启动 Windows PowerShell。采样器关闭、文件冻结或数据不可信时，执行器继续遵守资源门禁，不能禁用监控后开跑。

## Windows 发布入口

手动选一个全新的 UUID，并将可配置文件放在执行主机的 WSL 数据目录，例如：

```powershell
$producer = [Guid]::NewGuid().ToString()
powershell.exe -NoLogo -NoProfile -File scripts/sample-windows-resources.ps1 -OutputFile D:\WSL\state\resource-sampler\sample.json -ProducerId $producer -IntervalMs 2000 -StopFile D:\WSL\state\resource-sampler\owned.stop
```

后台调用者用 `Start-Process -WindowStyle Hidden -PassThru` 启动并保留 PID、producer UUID 与停止标记归属，不注册开机自启。只对自己创建的停止标记写入请求；采样器会在退出时尽力发布 `status: stopped`。采样器占用 `sample.json.writer.lock` 的独占文件句柄，不删除锁文件抢占；已存在未知格式的输出或复用旧 producer UUID 会被拒绝。该锁只保护采样文件单 writer，不代替 Linux 的 `heavy-task.lock`。

正常每2秒目标采样一次，单次 CIM 查询超时4秒。输出通过同目录临时文件与 `File.Replace` 原子替换，没有 `.previous` 采样备份轮转。每帧包含：

```json
{
  "format": "wsl-windows-resource-v1",
  "producerId": "11111111-1111-4111-8111-111111111111",
  "sequence": 2,
  "sourceMonotonicMs": 2010.5,
  "sampleDurationMs": 15.2,
  "sampledAt": "2026-01-01T00:00:00Z",
  "status": "available",
  "memory": { "availableBytes": 4294967296, "totalBytes": 17179869184 }
}
```

`sampledAt`、机器名和 PID 仅供审计，不用于跨机器或 Windows/Linux 的 wall-clock 新鲜度判断。CIM 失败会发布递增序列的 `unavailable` 帧及安全错误码，不沿用旧内存值伪装成功。

## Linux 只读消费者

`scripts/windows_resources.py` 仅依赖 Python 标准库。调用者可以作为独立工具引用，不必把项目验收交给工作台托管。同一验收生命周期复用一个 reader：

```python
from windows_resources import WindowsResourceReader, read_linux_resources, evaluate_resource_gate

reader = WindowsResourceReader('/mnt/d/WSL/state/resource-sampler/sample.json', producer_id=producer_uuid)
windows = reader.read()
linux = read_linux_resources()
gate = evaluate_resource_gate(windows, linux, mode='admission', peak_bytes=2 * 1024**3)
```

将 `scripts` 加入 `PYTHONPATH` 或用 `importlib` 从已安装工具路径加载。`reader.read()` 返回 `ready/status/reason/availableBytes/totalBytes/producerId/sequence/ageMs`；首帧必须等待第二个递增序列及源单调点，历史静态文件不能在新消费者启动时复活为新鲜数据。重复序列不更新接收时间；序列倒退、相同序列改内容、producer不匹配、源单调点未前进、采样失败或停止均不能通过门禁。

默认新鲜度8秒，采样耗时上限5秒；新鲜度依据 Linux 消费进程的 `time.monotonic()`，并验证源序列与 Stopwatch 单调点。重启采样器必须使用新 producer UUID，并由调用者重新绑定 reader；不要每个轮询都重建 reader。

也可一次性检查（默认最多等待12秒取得连续帧）：

```sh
python3 scripts/windows_resources.py --file /mnt/d/WSL/state/resource-sampler/sample.json --producer-id "$PRODUCER_ID" --wait-ready 12 --mode admission --peak-bytes 2147483648
```

准入通过退出0；等待退出75。运行中使用同一 reader 调用 `mode='low-water'`，未知／过期样本也返回 `interrupt`；CLI 对应退出130。执行器负责安全中断自己拥有的进程并保存真实结果，不停止别人的任务。

准入保留 Windows 2.5GiB、Linux 2GiB 下限，并按 `peak_bytes` 留出 Windows 1GiB、Linux 512MiB 余量。2GiB 峰值预算实际要求 Windows 3GiB、Linux 2.5GiB。运行低水位仍为 Windows 1GiB、Linux 512MiB。Swap只报告，不能当空闲内存；本接口不改 WSL 6GB 内存上限、swap、时钟、NTP、clocksource 或全局 WSL 生命周期。CPU负载、端口、精确进程归属和全命令期统一 `flock` 仍由项目执行器核实。

## 验证范围

匿名测试覆盖历史首帧、重复／倒退序列、producer切换、wall-date跳变、慢／失败样本和准入／低水位。实现不声称证明 Windows interop 与浏览器挂起的因果关系；受控 A/B 必须另有授权和独立记录。本接口本身不执行诊断、浏览器或产品验收，也不更改任何业务冻结源和运行脚本。

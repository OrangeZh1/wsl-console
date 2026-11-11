const linux=String.raw`import json,os,pathlib
fields={line.split(':')[0]:int(line.split()[1])*1024 for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.split()[0].rstrip(':') in ('MemTotal','MemAvailable','SwapTotal','SwapFree')}
def memory(total,available):return {'totalBytes':fields[total],'availableBytes':fields[available],'usedBytes':fields[total]-fields[available]}
lock=pathlib.Path.home()/'.local/state/wsl-progress/heavy-task.lock'
try:
 inode=str(lock.stat().st_ino);busy=any('FLOCK' in line and line.split()[5].rsplit(':',1)[-1]==inode for line in pathlib.Path('/proc/locks').read_text().splitlines())
except (OSError,IndexError):busy=None
print(json.dumps({'status':'available','state':'running','platform':'linux','memory':memory('MemTotal','MemAvailable'),'swap':memory('SwapTotal','SwapFree'),'cpu':{'logicalProcessors':os.cpu_count(),'load1':os.getloadavg()[0]},'lockBusy':busy}))`;

// This probe only reads state; listing a stopped distro does not start its VM.
export function windowsProbeScript(wsl={}){
 const distro=wsl.distro||'Ubuntu-24.04',user=wsl.user||'qicore-qa';
 if(!/^[a-z0-9_.-]+$/i.test(distro)||!/^[a-z_][a-z0-9_-]*$/.test(user))throw Error('DEVICE_WSL_CONFIG_INVALID');
 const code=Buffer.from(linux).toString('base64');
 return String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding
function Read-Wsl([string]$arguments,[bool]$unicode){$i=[Diagnostics.ProcessStartInfo]::new();$i.FileName="$env:SystemRoot\System32\wsl.exe";$i.Arguments=$arguments;$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;$i.StandardOutputEncoding=if($unicode){[Text.Encoding]::Unicode}else{[Text.Encoding]::UTF8};$p=[Diagnostics.Process]::Start($i);$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();if(-not $p.WaitForExit(4000)){$p.Kill();throw 'WSL_PROBE_TIMEOUT'};if($p.ExitCode -ne 0){throw 'WSL_PROBE_FAILED'};$o.Result.Trim()}
$os=Get-CimInstance Win32_OperatingSystem
$r=[pscustomobject]@{status='unavailable';state='unknown';platform='linux';memory=$null;swap=$null;cpu=$null}
try{$running=Read-Wsl '--list --running --quiet' $true;if(@($running -split "\r?\n"|ForEach-Object{$_.Trim()}) -contains '${distro}'){$r=(Read-Wsl '--distribution ${distro} --user ${user} --exec python3 -c "import base64;exec(base64.b64decode(''${code}''))"' $false)|ConvertFrom-Json}else{$r.state='stopped'}}catch{}
$stamp=[DateTime]::UtcNow.ToString('o');$r|Add-Member sampledAt $stamp -Force;$r|Add-Member windows @{availableBytes=[int64]$os.FreePhysicalMemory*1024;totalBytes=[int64]$os.TotalVisibleMemorySize*1024} -Force
[pscustomobject]@{computerName=[Environment]::MachineName;platform='win32';resources=$r}|ConvertTo-Json -Compress -Depth 8`;
}

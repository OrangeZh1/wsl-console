const linux=String.raw`import json,os,pathlib,re,time
fields={line.split(':')[0]:int(line.split()[1])*1024 for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.split()[0].rstrip(':') in ('MemTotal','MemAvailable','SwapTotal','SwapFree')}
def memory(total,available):return {'totalBytes':fields[total],'availableBytes':fields[available],'usedBytes':fields[total]-fields[available]}
lock=pathlib.Path.home()/'.local/state/wsl-progress/heavy-task.lock'
try:
 info=lock.stat();identity=(os.major(info.st_dev),os.minor(info.st_dev),info.st_ino)
 def matches(line):
  found=re.search(r'\bFLOCK\s+\S+\s+\S+\s+-?\d+\s+([0-9a-fA-F]+):([0-9a-fA-F]+):(\d+)\b',line)
  return bool(found and (int(found[1],16),int(found[2],16),int(found[3]))==identity)
 busy=any(matches(line) for line in pathlib.Path('/proc/locks').read_text().splitlines())
except (OSError,IndexError):busy=None
stamp=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
print(json.dumps({'status':'available','state':'running','platform':'linux','sampledAt':stamp,'memory':memory('MemTotal','MemAvailable'),'swap':memory('SwapTotal','SwapFree'),'cpu':{'logicalProcessors':os.cpu_count(),'load1':os.getloadavg()[0]},'lockBusy':busy,'lockSampledAt':stamp}))`;

// This probe only reads state; listing a stopped distro does not start its VM.
export function windowsProbeScript(wsl={}){
 const distro=wsl.distro||'Ubuntu-24.04',user=wsl.user||'qicore-qa';
 if(distro.length>80||user.length>64||!/^[a-z0-9_.-]+$/i.test(distro)||!/^[a-z_][a-z0-9_-]*$/.test(user))throw Error('DEVICE_WSL_CONFIG_INVALID');
 const code=Buffer.from(linux).toString('base64');
 return String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding
function Read-Wsl([string]$arguments,[bool]$unicode){$i=[Diagnostics.ProcessStartInfo]::new();$i.FileName="$env:SystemRoot\System32\wsl.exe";$i.Arguments=$arguments;$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;$i.StandardOutputEncoding=if($unicode){[Text.Encoding]::Unicode}else{[Text.Encoding]::UTF8};$p=[Diagnostics.Process]::Start($i);$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();if(-not $p.WaitForExit(4000)){$p.Kill();throw 'WSL_PROBE_TIMEOUT'};if($p.ExitCode -ne 0){throw 'WSL_PROBE_FAILED'};$o.Result.Trim()}
$os=Get-CimInstance Win32_OperatingSystem;$windowsStamp=[DateTime]::UtcNow.ToString('o')
$r=[pscustomobject]@{status='unavailable';state='unknown';platform='linux';memory=$null;swap=$null;cpu=$null}
try{$running=Read-Wsl '--list --running --quiet' $true;if(@($running -split "\r?\n"|ForEach-Object{$_.Trim()}) -contains '${distro}'){$r=(Read-Wsl '--distribution ${distro} --user ${user} --exec python3 -c "import base64;exec(base64.b64decode(''${code}''))"' $false)|ConvertFrom-Json}else{$r.state='stopped';$r|Add-Member sampledAt ([DateTime]::UtcNow.ToString('o')) -Force}}catch{$message=[string]$_.Exception.Message;$r|Add-Member diagnostic @{code=if($message -eq 'WSL_PROBE_TIMEOUT'){'WSL_PROBE_TIMEOUT'}else{'WSL_PROBE_FAILED'}} -Force}
$r|Add-Member windows @{availableBytes=[int64]$os.FreePhysicalMemory*1024;totalBytes=[int64]$os.TotalVisibleMemorySize*1024;sampledAt=$windowsStamp} -Force
[pscustomobject]@{computerName=[Environment]::MachineName;platform='win32';observedAt=[DateTime]::UtcNow.ToString('o');resources=$r}|ConvertTo-Json -Compress -Depth 8`;
}

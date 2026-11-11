param(
 [string]$OutputFile,
 [string]$ProducerId = '',
 [ValidateRange(250,60000)][int]$IntervalMs = 2000,
 [string]$StopFile,
 [ValidateRange(0,1000000000)][int]$StopAfterSamples = 0,
 [switch]$AsLibrary
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding

function New-WindowsResourceFrame {
 param([string]$Session,[long]$Sequence,[double]$MonotonicMs,[double]$DurationMs,[string]$Status,$Memory,[string]$ErrorCode='')
 $frame=[ordered]@{format='wsl-windows-resource-v1';producerId=$Session;sequence=$Sequence;sourceMonotonicMs=$MonotonicMs;sampleDurationMs=$DurationMs;sampledAt=[DateTime]::UtcNow.ToString('o');status=$Status;memory=$Memory;samplerPid=$PID;machineName=[Environment]::MachineName}
 if($ErrorCode){$frame.error=$ErrorCode}
 return $frame
}
function Write-WindowsResourceFrame {
 param([string]$Path,$Frame)
 $temporary=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Frame|ConvertTo-Json -Depth 6 -Compress)+[Environment]::NewLine)
 $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 if([IO.File]::Exists($Path)){[IO.File]::Replace($temporary,$Path,$null)}else{[IO.File]::Move($temporary,$Path)}
}
if($AsLibrary){return}

if(-not $OutputFile -or $OutputFile -notmatch '^[a-zA-Z]:[\\/]' -or [IO.Path]::GetExtension($OutputFile) -ne '.json'){throw 'A local absolute Windows JSON output path is required'}
$OutputFile=[IO.Path]::GetFullPath($OutputFile)
$sessionGuid=[Guid]::Empty
if(-not $ProducerId){$ProducerId=[Guid]::NewGuid().ToString()}elseif(-not [Guid]::TryParse($ProducerId,[ref]$sessionGuid)){throw 'ProducerId must be a new UUID'}else{$ProducerId=$sessionGuid.ToString()}
if($StopFile){$StopFile=[IO.Path]::GetFullPath($StopFile);if(Test-Path -LiteralPath $StopFile){throw 'Stop marker already exists; use a new owned marker'}}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputFile))|Out-Null
$writer=$null;$published=$false;$sequence=0;$clock=[Diagnostics.Stopwatch]::StartNew()
try {
 try{$writer=[IO.File]::Open($OutputFile+'.writer.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{throw 'Sampler output already has a writer or its lock cannot be opened'}
 if(Test-Path -LiteralPath $OutputFile){
  $item=Get-Item -LiteralPath $OutputFile
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Resource output is not a regular file'}
  $old=[IO.File]::ReadAllText($OutputFile,[Text.Encoding]::UTF8)|ConvertFrom-Json
  if($old.format -ne 'wsl-windows-resource-v1'){throw 'Existing output has an unknown format; preserve it'}
  if($old.producerId -eq $ProducerId){throw 'Do not reuse a producer UUID after sampler restart'}
 }
 $nextAt=0.0
 while($true){
  if($StopFile -and (Test-Path -LiteralPath $StopFile)){break}
  $sequence++;$begin=$clock.Elapsed.TotalMilliseconds
  try{
   $os=Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 4
   $memory=@{availableBytes=[int64]$os.FreePhysicalMemory*1024;totalBytes=[int64]$os.TotalVisibleMemorySize*1024}
   $frame=New-WindowsResourceFrame $ProducerId $sequence $clock.Elapsed.TotalMilliseconds ($clock.Elapsed.TotalMilliseconds-$begin) 'available' $memory
  }catch{$frame=New-WindowsResourceFrame $ProducerId $sequence $clock.Elapsed.TotalMilliseconds ($clock.Elapsed.TotalMilliseconds-$begin) 'unavailable' $null 'CIM_QUERY_FAILED'}
  Write-WindowsResourceFrame $OutputFile $frame;$published=$true
  if($sequence -eq 1){@{format='wsl-windows-sampler-session-v1';producerId=$ProducerId;pid=$PID;outputFile=$OutputFile;intervalMs=$IntervalMs;automaticStartup=$false}|ConvertTo-Json -Compress}
  if($StopAfterSamples -gt 0 -and $sequence -ge $StopAfterSamples){break}
  $nextAt+=$IntervalMs;$delay=[int][Math]::Max(0,$nextAt-$clock.Elapsed.TotalMilliseconds)
  if($delay -gt 0){Start-Sleep -Milliseconds $delay}else{$nextAt=$clock.Elapsed.TotalMilliseconds}
 }
} finally {
 if($published){try{$sequence++;Write-WindowsResourceFrame $OutputFile (New-WindowsResourceFrame $ProducerId $sequence $clock.Elapsed.TotalMilliseconds 0 'stopped' $null)}catch{[Console]::Error.WriteLine('Sampler terminal frame could not be saved; consumers must expire the last sequence')}}
 if($writer){$writer.Dispose()};$clock.Stop()
}

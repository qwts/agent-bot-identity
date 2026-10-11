// Bot-owned implementation of the job lifetime pattern reviewed in agent-comms #148.
// Own the task's complete process tree without enumerating or killing PIDs.
// The handle is unnamed and non-inheritable; task termination closes it even
// when PowerShell cannot run finally. Windows then terminates this job only.
export function windowsTaskJobScript(commandLine) {
  const literal = String(commandLine).replaceAll("'", "''");
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AgentBotTaskJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic BasicLimitInformation;
    public Io IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  // Intentionally retain this non-inheritable handle until process exit.
  static IntPtr job;
  public static void Enter() {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    Extended info = new Extended();
    info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended))))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, GetCurrentProcess()))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
[AgentBotTaskJob]::Enter()
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = "$env:SystemRoot\\System32\\cmd.exe"
$start.Arguments = '${literal}'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$child = [System.Diagnostics.Process]::Start($start)
$child.WaitForExit()
exit $child.ExitCode
`;
}

export function windowsTaskJobArguments(commandLine) {
  return `-NoProfile -NonInteractive -EncodedCommand ${Buffer.from(windowsTaskJobScript(commandLine), 'utf16le').toString('base64')}`;
}

// Read only the fixed literal emitted by this wrapper; never evaluate a unit.
export function windowsTaskJobCommandLine(argumentsText) {
  const encoded = /^-NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(argumentsText);
  if (!encoded) return null;
  const script = Buffer.from(encoded[1], 'base64').toString('utf16le');
  const literal = /^\$start\.Arguments = '((?:[^']|'')*)'$/m.exec(script);
  return literal ? literal[1].replaceAll("''", "'") : null;
}

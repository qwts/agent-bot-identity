import { execFileSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles;
public static class AgentBotInstallPath {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string n,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder b,uint n,uint f);
 public static string Read(string path) {
  using(var h=CreateFile(path,0x80,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)) {
   if(h.IsInvalid) throw new Exception("install-directory-refused");
   var b=new StringBuilder(4096); uint n=GetFinalPathNameByHandle(h,b,4096,0);
   if(n==0||n>=4096) throw new Exception("install-directory-refused");
   return b.ToString();
  }
 }
}
'@
[Console]::Out.Write([AgentBotInstallPath]::Read([Console]::In.ReadToEnd()))`;

// Node's realpath preserves an MSIX logical alias. The scheduler is outside
// that package: use the opened directory handle's actual path for its cwd/log.
export function windowsInstallDirectory(directory, { env = process.env, run = execFileSync } = {}) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'psmodulepath') delete childEnv[key];
  const value = run(path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    { input: directory, encoding: 'utf8', env: childEnv, windowsHide: true, timeout: 15000, maxBuffer: 16384 });
  if (typeof value !== 'string' || !/^\\\\\?\\[A-Za-z]:\\[^\r\n\0]+$/.test(value)) throw new Error('install-directory-refused');
  return value.slice(4);
}

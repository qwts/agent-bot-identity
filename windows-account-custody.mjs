// Windows account custody for identity-owned private state. This mirrors
// agent-comms' SID/profile boundary: ownership is read through Get-Acl, and
// paths must be real files or directories rather than reparse points.
import { spawnSync } from 'node:child_process';

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'];
const SID = /^S-1-\d+(?:-\d+)+$/;
const SID_IN = 'S-1-\\d+(?:-\\d+)+';
const WHOAMI_CSV = new RegExp(`^\"(?:[^\"]|\"\")*\",\"(${SID_IN})\"\\s*$`, 'm');
const ENTRY = new RegExp(`^(${SID_IN})\\|(directory|file)\\|(real|link)$`);

export function isWindowsSid(value) {
  return typeof value === 'string' && SID.test(value);
}

function quoteForPowerShell(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error('Windows custody path cannot contain a line break');
  return `'${text.replace(/'/g, "''")}'`;
}

export function createWindowsAccountCustody({ run = spawnSync } = {}) {
  let cachedSid = null;

  function currentSid() {
    if (cachedSid) return cachedSid;
    const result = run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sid = result?.status === 0 ? WHOAMI_CSV.exec(String(result.stdout ?? ''))?.[1] : null;
    if (!isWindowsSid(sid)) throw new Error('cannot determine this account SID');
    cachedSid = sid;
    return sid;
  }

  function inspect(file) {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$p = ${quoteForPowerShell(file)}`,
      "try { $i = Get-Item -LiteralPath $p -Force; $o = (Get-Acl -LiteralPath $p).GetOwner([System.Security.Principal.SecurityIdentifier]).Value; $k = if ($i.PSIsContainer) { 'directory' } else { 'file' }; $r = if ([int]($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { 'link' } else { 'real' }; [Console]::Out.Write(($o, $k, $r) -join '|') } catch { [Console]::Out.Write('missing') }",
      '',
      '',
    ].join('\n');
    const result = run('powershell.exe', POWERSHELL_ARGS, {
      input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result?.status !== 0) throw new Error('Windows custody could not inspect the path');
    const answer = String(result.stdout ?? '').trim();
    if (answer === 'missing') throw new Error('Windows custody path is missing or cannot be inspected');
    const match = ENTRY.exec(answer);
    if (!match) throw new Error('Windows custody returned an invalid ownership record');
    return { owner: match[1], kind: match[2], link: match[3] === 'link' };
  }

  function assertOwnedDirectory(file, sid) {
    if (!isWindowsSid(sid)) throw new Error('expected account SID is invalid');
    const entry = inspect(file);
    if (entry.kind !== 'directory' || entry.link) throw new Error('Windows custody path is not a real directory');
    if (entry.owner !== sid) throw new Error('Windows custody directory is owned by another account');
    return entry;
  }

  function assertOwnedFile(file, sid) {
    if (!isWindowsSid(sid)) throw new Error('expected account SID is invalid');
    const entry = inspect(file);
    if (entry.kind !== 'file' || entry.link) throw new Error('Windows custody path is not a real file');
    if (entry.owner !== sid) throw new Error('Windows custody file is owned by another account');
    return entry;
  }

  function restrictPrivateFile(file, sid) {
    if (!isWindowsSid(sid)) throw new Error('expected account SID is invalid');
    assertOwnedFile(file, sid);
    const result = run('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${sid}:F`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result?.status !== 0) throw new Error('Windows private-file access could not be restricted');
    assertOwnedFile(file, sid);
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$p = ${quoteForPowerShell(file)}`,
      `$owner = '${sid}'`,
      'try {',
      '  $item = Get-Item -LiteralPath $p -Force',
      '  if (-not $item -or $item.PSIsContainer -or [int]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw \'file\' }',
      '  $acl = Get-Acl -LiteralPath $p',
      '  if (-not $acl -or -not $acl.AreAccessRulesProtected) { throw \'inheritance\' }',
      '  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])',
      '  if ($null -eq $rules -or $rules.Count -lt 1) { throw \'rules\' }',
      '  $full = [System.Security.AccessControl.FileSystemRights]::FullControl',
      '  $ownerFullControl = $false',
      '  foreach ($rule in $rules) {',
      '    if (-not $rule -or $null -eq $rule.IdentityReference -or $null -eq $rule.AccessControlType) { throw \'rule\' }',
      '    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {',
      '      if ($rule.IdentityReference.Value -ne $owner) { throw \'foreign allow\' }',
      '      if (($rule.FileSystemRights -band $full) -eq $full) { $ownerFullControl = $true }',
      '    }',
      '  }',
      '  if (-not $ownerFullControl) { throw \'owner grant\' }',
      "  [Console]::Out.Write('owner-only')",
      '} catch {',
      "  [Console]::Out.Write('refused')",
      '}',
      '',
      '',
    ].join('\n');
    const verified = run('powershell.exe', POWERSHELL_ARGS, {
      input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (verified?.status !== 0 || String(verified.stdout ?? '').trim() !== 'owner-only') {
      throw new Error('Windows private-file access could not be verified');
    }
  }

  return Object.freeze({ currentSid, assertOwnedDirectory, assertOwnedFile, restrictPrivateFile });
}

# One-off generator for the committed .lnk fixtures (documentation; tests never run this).
# Creates shortcuts with WScript.Shell. Windows only writes a LinkInfo block when the target
# exists, so the local fixtures point at files inside a throwaway directory that is mapped to
# drive Q: with `subst`, which keeps the stored paths machine-independent (Q:\...).
# WScript.Shell converts TargetPath through the ANSI code page, so only cp1252 characters work.
# The UNC fixture points at the local loopback admin share (no external network traffic).
$ErrorActionPreference = 'Stop'
$out = $PSScriptRoot
$tmp = Join-Path $env:TEMP ('nuke-lnk-fx-' + [guid]::NewGuid().ToString('N'))
$uniName = [string][char]0x00DC + 'n' + [char]0x00EF + ' ' + [char]0x20AC
New-Item -ItemType Directory -Path (Join-Path $tmp $uniName), (Join-Path $tmp 'plain') | Out-Null
Set-Content (Join-Path $tmp "$uniName\app.exe") 'x'
Set-Content (Join-Path $tmp 'plain\tool.exe') 'x'
subst Q: $tmp
try {
  $sh = New-Object -ComObject WScript.Shell
  function Make($name, $target, $arguments, $wd) {
    $l = $sh.CreateShortcut((Join-Path $out $name))
    $l.TargetPath = $target
    if ($arguments) { $l.Arguments = $arguments }
    if ($wd) { $l.WorkingDirectory = $wd }
    $l.Save()
  }
  Make 'unicode.lnk' "Q:\$uniName\app.exe" '--flag "x y" -q' "Q:\$uniName"
  Make 'ansi.lnk' 'Q:\plain\tool.exe' '/silent' 'Q:\plain'
  Make 'envvar.lnk' '%windir%\nukefixture-notepad.exe' '' ''
  Make 'unc.lnk' '\\localhost\c$\Windows\System32\notepad.exe' '-r' ''
} finally {
  subst Q: /d
  Remove-Item -Recurse -Force $tmp
}

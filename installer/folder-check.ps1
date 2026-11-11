# Tells Flick's installer (flick.nsi) whether folders can be changed only by administrators. A folder of your choice
# outside Program Files is used only when every folder on the way to it that exists already is like that: anyone else
# who could rename or replace one of them could put their own Flick.exe, or uninstaller, where the installer registered
# them. The folders come in $env:FLICK_FOLDERS, separated by |.
# Exit 0: each is owned by SYSTEM, Administrators or TrustedInstaller, and no one else may write in it, delete or rename
# it, or change its permissions or owner. Exit 1 (saying which and who can) otherwise; 2 if it can't tell.
$ErrorActionPreference = 'Stop'
$admins = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
# write data or add a file, append or add a folder, write extended attributes, delete what is in it, write attributes,
# delete, change permissions, take ownership, and the generic all and write rights
$change = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
$folder = ''
try {
  foreach ($folder in ($env:FLICK_FOLDERS -split '\|')) {
    if (-not $folder) { continue }
    $acl = Get-Acl -LiteralPath $folder
    $who = @()
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($admins -notcontains $owner) { $who += "its owner $owner" }
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
      # (a rule only for what is made inside it later doesn't apply to the folder itself)
      if (([int]$rule.PropagationFlags -band 2) -ne 0) { continue }                       # InheritOnly
      if ($admins -contains $rule.IdentityReference.Value) { continue }
      if (([int64]$rule.FileSystemRights) -band $change) { $who += "$($rule.IdentityReference.Value) ($($rule.FileSystemRights))" }
    }
    if ($who.Count) { [Console]::Out.WriteLine("$folder can be changed by " + ($who -join ', ')); exit 1 }
  }
  exit 0
} catch {
  [Console]::Out.WriteLine("can't tell who can change ${folder}: $($_.Exception.Message)")
  exit 2
}

# Exports the fishing sections of OneNote to data/raw (read-only on the OneNote side).
param(
  [string]$SectionPattern = '^(3-|4-|6\.)',
  [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'data\raw')
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$on = New-Object -ComObject OneNote.Application

$hierarchy = ''
# hsPages = 4
$on.GetHierarchy('', 4, [ref]$hierarchy)
[xml]$doc = $hierarchy
$ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
$ns.AddNamespace('one', $doc.DocumentElement.NamespaceURI)

$md5 = [System.Security.Cryptography.MD5]::Create()
$manifest = New-Object System.Collections.ArrayList
$failed = 0
$images = 0
$imageFailed = 0

foreach ($s in $doc.SelectNodes('//one:Section', $ns)) {
  if ($s.name -notmatch $SectionPattern) { continue }
  $order = 0
  foreach ($p in $s.SelectNodes('one:Page', $ns)) {
    $order++
    $hash = $md5.ComputeHash($utf8.GetBytes($p.ID))
    $key = ([System.BitConverter]::ToString($hash) -replace '-', '').Substring(0, 16).ToLower()
    $file = Join-Path $OutDir "$key.xml"
    try {
      $xml = ''
      # piBasic = 0. Asking for inline binaries (piBinaryData) silently drops some images,
      # so each one is fetched by its callback ID instead.
      $on.GetPageContent($p.ID, [ref]$xml, 0)
      [xml]$pageDoc = $xml
      $pns = New-Object System.Xml.XmlNamespaceManager($pageDoc.NameTable)
      $pns.AddNamespace('one', $pageDoc.DocumentElement.NamespaceURI)
      foreach ($img in $pageDoc.SelectNodes('//one:Image', $pns)) {
        $cb = $img.SelectSingleNode('one:CallbackID', $pns)
        if (-not $cb) { continue }
        try {
          $b64 = ''
          $on.GetBinaryPageContent($p.ID, $cb.GetAttribute('callbackID'), [ref]$b64)
          $data = $pageDoc.CreateElement('one', 'Data', $pageDoc.DocumentElement.NamespaceURI)
          $data.InnerText = $b64
          [void]$img.AppendChild($data)
          $images++
        } catch {
          $imageFailed++
          Write-Warning "IMAGE FAILED: $($s.name) / $($p.name): $_"
        }
      }
      [System.IO.File]::WriteAllText($file, $pageDoc.OuterXml, $utf8)
      [void]$manifest.Add([ordered]@{
        key = $key; section = $s.name; title = $p.name; order = $order
        level = [int]$p.pageLevel; created = $p.dateTime; modified = $p.lastModifiedTime
      })
    } catch {
      $failed++
      Write-Warning "FAILED: $($s.name) / $($p.name): $_"
    }
  }
}

$json = ConvertTo-Json -InputObject $manifest -Depth 4
[System.IO.File]::WriteAllText((Join-Path (Split-Path -Parent $OutDir) 'manifest.json'), $json, $utf8)
"pages: $($manifest.Count)  failed: $failed  images: $images  image failed: $imageFailed"

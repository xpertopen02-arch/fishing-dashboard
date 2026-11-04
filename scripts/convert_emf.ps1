# Browsers cannot show EMF, so OneNote's EMF images are rendered to PNG next to the source.
param([Parameter(Mandatory)][string]$Dir, [int]$MaxWidth = 1800)
Add-Type -AssemblyName System.Drawing
foreach ($f in Get-ChildItem -Path $Dir -Filter *.emf) {
  $img = [System.Drawing.Image]::FromFile($f.FullName)
  $w = [math]::Min($MaxWidth, $img.Width)
  $h = [int]($img.Height * $w / $img.Width)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.DrawImage($img, 0, 0, $w, $h)
  $bmp.Save(($f.FullName -replace '\.emf$', '.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  Remove-Item -LiteralPath $f.FullName
}

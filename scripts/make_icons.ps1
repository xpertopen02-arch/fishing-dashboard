# Draws the app icons. The fish stays inside the central 80%, which Android keeps when it masks the icon to a circle.
param([string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'site\icons'))
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Save-Icon([int]$size, [string]$name) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.ScaleTransform($size / 512.0, $size / 512.0)
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#1c5cab'))

  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $blue = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#1c5cab'))

  $g.FillEllipse($white, 128, 176, 236, 136)
  $tail = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF 150, 244),
    (New-Object System.Drawing.PointF 76, 172),
    (New-Object System.Drawing.PointF 96, 244),
    (New-Object System.Drawing.PointF 76, 316)
  )
  $g.FillPolygon($white, $tail)
  $g.FillEllipse($blue, 306, 216, 24, 24)

  $wave = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 18
  $wave.StartCap = 'Round'; $wave.EndCap = 'Round'
  $g.DrawBezier($wave, 120, 366, 170, 336, 210, 396, 256, 366)
  $g.DrawBezier($wave, 256, 366, 302, 336, 342, 396, 392, 366)

  $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $wave.Dispose(); $blue.Dispose(); $white.Dispose(); $g.Dispose(); $bmp.Dispose()
}

Save-Icon 192 'icon-192.png'
Save-Icon 512 'icon-512.png'
Save-Icon 180 'apple-touch-icon.png'

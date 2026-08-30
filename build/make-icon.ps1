# 生成应用图标 build/icon.png (512x512)：墨底圆角方块 + 琥珀-玉色双生水滴（生境意象）
Add-Type -AssemblyName System.Drawing

$size = 512
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# 圆角方块底
$rr = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 112; $x = 8; $y = 8; $w = 496; $h = 496
$rr.AddArc($x, $y, $r, $r, 180, 90)
$rr.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
$rr.AddArc($x + $w - $r, $y + $h - $r, $r, $r, 0, 90)
$rr.AddArc($x, $y + $h - $r, $r, $r, 90, 90)
$rr.CloseFigure()
$cA = [System.Drawing.Color]::FromArgb(255, 18, 21, 31)
$cB = [System.Drawing.Color]::FromArgb(255, 30, 36, 51)
$pa = New-Object System.Drawing.Point(0, 0)
$pb = New-Object System.Drawing.Point(512, 512)
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($pa, $pb, $cA, $cB)
$g.FillPath($bgBrush, $rr)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 44, 52, 71), 3)
$g.DrawPath($pen, $rr)

# 水滴：两条贝塞尔（尖顶→腰部）+ 下半圆弧
function New-Drop {
  param([float]$cx, [float]$top, [float]$halfW, [float]$bottom)
  $ccy = $bottom - $halfW
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddBezier(($cx - $halfW), $ccy, ($cx - $halfW * 0.9), ($top + ($ccy - $top) * 0.4), ($cx - $halfW * 0.45), $top, $cx, $top)
  $p.AddBezier($cx, $top, ($cx + $halfW * 0.45), $top, ($cx + $halfW * 0.9), ($top + ($ccy - $top) * 0.4), ($cx + $halfW), $ccy)
  $p.AddArc(($cx - $halfW), ($ccy - $halfW), (2 * $halfW), (2 * $halfW), 0, 180)
  $p.CloseFigure()
  return $p
}

$c1 = [System.Drawing.Color]::FromArgb(255, 240, 201, 141)
$c2 = [System.Drawing.Color]::FromArgb(255, 226, 165, 95)
$q1 = New-Object System.Drawing.Point(150, 90)
$q2 = New-Object System.Drawing.Point(370, 430)
$amberBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($q1, $q2, $c1, $c2)
$outer = New-Drop -cx 256 -top 92 -halfW 118 -bottom 424
$g.FillPath($amberBrush, $outer)

$c3 = [System.Drawing.Color]::FromArgb(255, 127, 216, 180)
$c4 = [System.Drawing.Color]::FromArgb(255, 95, 196, 158)
$q3 = New-Object System.Drawing.Point(190, 170)
$q4 = New-Object System.Drawing.Point(320, 360)
$jadeBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($q3, $q4, $c3, $c4)
$inner = New-Drop -cx 256 -top 176 -halfW 62 -bottom 356
$g.FillPath($jadeBrush, $inner)

$g.Dispose()
New-Item -ItemType Directory -Force -Path build | Out-Null
$bmp.Save("build\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "icon.png generated: $((Get-Item build\icon.png).Length) bytes"

# scripts/make-icon.ps1
#
# Generates build/icon.png (512x512) and build/icon.ico (multi-size) for the
# packaged app, drawn from the renderer palette in src/styles/global.css:
# #020a10 ground, #7fd8ef accent. Run only when the mark changes -- the outputs
# are committed, so a normal build does not need PowerShell or System.Drawing.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
if (-not (Test-Path $buildDir)) { New-Item -ItemType Directory -Path $buildDir | Out-Null }

function New-IconBitmap {
    param([int]$Size)
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = [double]$Size
    # Rounded-square ground.
    $r = $s * 0.22
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
    $path.AddArc($s - $r * 2, 0, $r * 2, $r * 2, 270, 90)
    $path.AddArc($s - $r * 2, $s - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc(0, $s - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    $ground = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 2, 10, 16))
    $g.FillPath($ground, $path)

    # Accent ring.
    $inset = $s * 0.20
    $penW = [Math]::Max(1.0, $s * 0.055)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 127, 216, 239), $penW)
    $g.DrawEllipse($pen, $inset, $inset, $s - $inset * 2, $s - $inset * 2)

    # Ascending chevron inside the ring.
    $cx = $s / 2.0
    $cy = $s / 2.0
    $w = $s * 0.15
    $h = $s * 0.13
    $pen2 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 216, 246, 255), $penW)
    $pen2.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen2.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen2.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pts = @(
        (New-Object System.Drawing.PointF([float]($cx - $w), [float]($cy + $h))),
        (New-Object System.Drawing.PointF([float]$cx, [float]($cy - $h))),
        (New-Object System.Drawing.PointF([float]($cx + $w), [float]($cy + $h)))
    )
    $g.DrawLines($pen2, $pts)

    $pen.Dispose(); $pen2.Dispose(); $ground.Dispose(); $path.Dispose(); $g.Dispose()
    return $bmp
}

# --- PNG (used by BrowserWindow icon on Linux/dev) ---
$png = New-IconBitmap -Size 512
$pngPath = Join-Path $buildDir 'icon.png'
$png.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$png.Dispose()
Write-Output "wrote $pngPath"

# --- ICO (used by NSIS, the exe, and shortcuts) ---
# Built by hand: an ICONDIR + one ICONDIRENTRY per size, each pointing at a
# PNG-compressed image. Windows Vista+ reads PNG entries at every size.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$blobs = @()
foreach ($sz in $sizes) {
    $bmp = New-IconBitmap -Size $sz
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $blobs += , $ms.ToArray()
    $ms.Dispose(); $bmp.Dispose()
}

$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
$bw.Write([UInt16]0)               # reserved
$bw.Write([UInt16]1)               # type: icon
$bw.Write([UInt16]$sizes.Count)
$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]
    # 256 is encoded as 0 in the single-byte width/height fields.
    $dim = if ($sz -ge 256) { 0 } else { $sz }
    $bw.Write([Byte]$dim)          # width
    $bw.Write([Byte]$dim)          # height
    $bw.Write([Byte]0)             # palette count
    $bw.Write([Byte]0)             # reserved
    $bw.Write([UInt16]1)           # color planes
    $bw.Write([UInt16]32)          # bits per pixel
    $bw.Write([UInt32]$blobs[$i].Length)
    $bw.Write([UInt32]$offset)
    $offset += $blobs[$i].Length
}
foreach ($b in $blobs) { $bw.Write($b) }
$bw.Flush()
$icoPath = Join-Path $buildDir 'icon.ico'
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
$bw.Dispose(); $out.Dispose()
Write-Output "wrote $icoPath ($($sizes.Count) sizes)"

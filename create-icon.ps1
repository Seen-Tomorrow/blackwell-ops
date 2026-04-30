# Create a minimal 16x16 ICO file with proper DIB header
Add-Type -AssemblyName System.Drawing

$size = 16
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(0, 10, 15))

# Draw a simple green square
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(118, 185, 0))
$g.FillRectangle($brush, 2, 2, $size - 4, $size - 4)

$icoPath = "C:\Users\GHOST-TOWER\INFRA\blackwell-ops\src-tauri\icons\icon.ico"
New-Item -ItemType Directory -Force -Path (Split-Path $icoPath) | Out-Null

# Save BMP to memory
$bmpStream = New-Object System.IO.MemoryStream
$bmp.Save($bmpStream, [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmpBytes = $bmpStream.ToArray()
$bmpStream.Dispose()

# Create proper ICO with BITMAPINFOHEADER (40 bytes DIB header)
$icoStream = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($icoStream)

# ICO Header (6 bytes)
$bw.Write([byte[]](0x00, 0x00))       # Reserved
$bw.Write([Int16](1))                  # Type (ICO)
$bw.Write([Int16](1))                  # Image count

# Directory Entry (16 bytes) - for 16x16 image
$bw.Write([byte]$size)                 # Width = 16
$bw.Write([byte]$size)                 # Height = 16
$bw.Write([byte]0)                     # Color palette
$bw.Write([byte]0)                     # Reserved

$bw.Write([Int16](1))                  # Color planes
$bw.Write([Int16](32))                 # Bits per pixel

# Image size (little-endian uint32) - includes DIB header + pixel data
$dibHeader = 40                        # BITMAPINFOHEADER size
$imgSize = $dibHeader + $bmpBytes.Length
$sizeBytes = [BitConverter]::GetBytes([int]$imgSize)
$bw.Write($sizeBytes)

# Offset to image data (6 + 16 = 22, little-endian uint32)
$offset = 22
$offBytes = [BitConverter]::GetBytes([int]$offset)
$bw.Write($offBytes)

# BITMAPINFOHEADER (40 bytes) - this is the key part that was wrong before
$bw.Write([Int32](40))                 # DIB header size
$bw.Write([Int32]($size))              # Width
$bw.Write([Int32]($size * 2))          # Height (doubled for ICO - includes mask)
$bw.Write([Int16](1))                  # Color planes
$bw.Write([Int16](32))                 # Bits per pixel
$bw.Write([Int32](0))                  # Compression (none)
$bw.Write([Int32]($bmpBytes.Length))   # Image size
$bw.Write([Int32](0))                  # Horizontal resolution
$bw.Write([Int32](0))                  # Vertical resolution
$bw.Write([Int32](0))                  # Colors used
$bw.Write([Int32](0))                  # Important colors

# Pixel data (BMP rows are bottom-to-top, 4-byte aligned)
$rowSize = [int](([int]$size * 4 + 3) -band (-bnot 3))
for ($i = $bmpBytes.Length - 1; $i -ge 0; $i -= 4) {
    $bw.Write($bmpBytes[$i-2])
    $bw.Write($bmpBytes[$i-1])
    $bw.Write($bmpBytes[$i])
    $bw.Write([byte]0xFF)              # Alpha channel (opaque)
}

$bw.Close()
$icoStream.Dispose()
$g.Dispose()
$bmp.Dispose()

Write-Host "ICO created: $icoPath"
Write-Host "Size: $((Get-Item $icoPath).Length) bytes"

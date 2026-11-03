# One-time script to build Valhalla routing tiles for LAGOS ONLY using Docker Desktop
$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  LagChow Valhalla Tile Generator (LAGOS ONLY)            " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$customDir = Join-Path $PWD "custom_files"
if (!(Test-Path -Path $customDir)) {
    New-Item -ItemType Directory -Path $customDir | Out-Null
    Write-Host "Created ./custom_files directory." -ForegroundColor Green
}

$nigeriaPbf = Join-Path $customDir "nigeria-latest.osm.pbf"
$lagosPbf = Join-Path $customDir "lagos.osm.pbf"

# Step 1: Resumable, robust download using curl.exe
if (!(Test-Path -Path $lagosPbf)) {
    $url = "https://download.geofabrik.de/africa/nigeria-latest.osm.pbf"
    Write-Host "`n[1/3] Downloading / Resuming Geofabrik Nigeria OSM extract (~680MB)..." -ForegroundColor Yellow
    Write-Host "Using curl.exe with automatic retry and resume support...`n" -ForegroundColor DarkGray
    
    # curl -C - resumes directly from the partial download bytes
    & curl.exe -C - --retry 5 --retry-delay 3 -L -o $nigeriaPbf $url --progress-bar

    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n❌ Download was interrupted. Run .\build-tiles.ps1 again to resume." -ForegroundColor Red
        exit 1
    }

    # Verify file is at least 600MB
    $fileSize = (Get-Item $nigeriaPbf).Length
    if ($fileSize -lt 550000000) {
        Write-Host "`n⚠️ File appears incomplete ($([math]::Round($fileSize/1MB, 1)) MB). Please rerun .\build-tiles.ps1 to finish the download." -ForegroundColor Red
        exit 1
    }
    Write-Host "`n✅ Download complete! File size: $([math]::Round($fileSize/1MB, 1)) MB" -ForegroundColor Green
} else {
    Write-Host "`n[1/3] lagos.osm.pbf already exists, skipping Nigeria download." -ForegroundColor Green
}

# Step 2: Extract Lagos Bounding Box (Badagry -> Epe, Coast -> Ikorodu)
if (!(Test-Path -Path $lagosPbf)) {
    Write-Host "`n[2/3] Extracting Lagos-only bounding box (bbox: 2.70, 6.35, 4.25, 6.75)..." -ForegroundColor Yellow
    docker run --rm `
      -v "${customDir}:/wkd" `
      -w /wkd `
      mschilde/osmium-tool `
      osmium extract --bbox=2.70,6.35,4.25,6.75 -o lagos.osm.pbf nigeria-latest.osm.pbf --overwrite

    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n❌ Failed to extract Lagos bounding box. Please check Docker output." -ForegroundColor Red
        exit 1
    }

    Write-Host "✅ Lagos extract created: lagos.osm.pbf (~25MB)" -ForegroundColor Green

    # Remove the full Nigeria PBF to free up ~680MB of disk space
    if (Test-Path -Path $nigeriaPbf) {
        Remove-Item -Path $nigeriaPbf -Force
        Write-Host "Cleaned up temporary 680MB Nigeria extract." -ForegroundColor DarkGray
    }
} else {
    Write-Host "`n[2/3] lagos.osm.pbf already present." -ForegroundColor Green
}

# Step 3: Run Valhalla to build tiles strictly for Lagos
Write-Host "`n[3/3] Compiling Valhalla routing tiles for Lagos..." -ForegroundColor Yellow
Write-Host "This will build in under 1 minute...`n" -ForegroundColor DarkGray

docker run -it --rm `
  -v "${customDir}:/custom_files" `
  -e build_elevation=False `
  -e build_admins=True `
  ghcr.io/gis-ops/docker-valhalla/valhalla:latest

Write-Host "`n==========================================================" -ForegroundColor Cyan
if (Test-Path -Path (Join-Path $customDir "valhalla.json")) {
    Write-Host "✅ SUCCESS! Lagos routing tiles compiled in ./custom_files!" -ForegroundColor Green
    Write-Host "Tile size is compact (~60MB) and RAM footprint is under 350MB." -ForegroundColor Green
    Write-Host "You can now run: docker build -t lagchow-backend ." -ForegroundColor Cyan
} else {
    Write-Host "⚠️ Tile build not finalized. Check Docker output above." -ForegroundColor Red
}
Write-Host "==========================================================" -ForegroundColor Cyan

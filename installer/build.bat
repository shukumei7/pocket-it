@echo off
setlocal

echo === Pocket IT Build ===
echo.

:: Check for dotnet
where dotnet >nul 2>&1
if errorlevel 1 (
    echo ERROR: .NET SDK not found. Install from https://dotnet.microsoft.com/download/dotnet/8.0
    exit /b 1
)

:: Publish self-contained
echo [1/1] Publishing self-contained app...
cd /d "%~dp0..\client\PocketIT"
dotnet publish -c Release -r win-x64 --self-contained -o "..\publish\win-x64" -p:PublishSingleFile=false -p:IncludeNativeLibrariesForSelfExtract=false
if errorlevel 1 (
    echo ERROR: dotnet publish failed
    exit /b 1
)
echo      Published to client\publish\win-x64
echo.

echo === Build complete! ===
echo.

echo === Auto-publishing to server ===
curl -s --max-time 30 -X POST http://localhost:9100/api/updates/publish-local 2>nul
if errorlevel 1 (
    echo WARNING: Auto-publish failed. Is the server running?
) else (
    echo Update published and pushed to connected devices.
)

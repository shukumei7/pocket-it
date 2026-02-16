@echo off
setlocal

echo === Pocket IT Installer Build ===
echo.

:: Check for dotnet
where dotnet >nul 2>&1
if errorlevel 1 (
    echo ERROR: .NET SDK not found. Install from https://dotnet.microsoft.com/download/dotnet/8.0
    exit /b 1
)

:: Check for Inno Setup
set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
    echo ERROR: Inno Setup 6 not found at %ISCC%
    echo Install from https://jrsoftware.org/isdl.php
    exit /b 1
)

:: Step 1: Publish self-contained
echo [1/2] Publishing self-contained app...
cd /d "%~dp0..\client\PocketIT"
dotnet publish -c Release -r win-x64 --self-contained -o "..\publish\win-x64" -p:PublishSingleFile=false -p:IncludeNativeLibrariesForSelfExtract=false
if errorlevel 1 (
    echo ERROR: dotnet publish failed
    exit /b 1
)
echo      Published to client\publish\win-x64
echo.

:: Step 2: Build installer
echo [2/2] Building Inno Setup installer...
cd /d "%~dp0"
"%ISCC%" pocket-it.iss
if errorlevel 1 (
    echo ERROR: Inno Setup compilation failed
    exit /b 1
)

echo.
echo === Build complete! ===
echo Installer: %~dp0output\PocketIT-0.2.1-setup.exe
echo.
echo Silent install:  PocketIT-0.2.1-setup.exe /SILENT
echo Very silent:     PocketIT-0.2.1-setup.exe /VERYSILENT /SUPPRESSMSGBOXES
echo Custom config:   PocketIT-0.2.1-setup.exe /SILENT /DIR="C:\PocketIT"

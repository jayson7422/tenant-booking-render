@echo off
setlocal EnableExtensions

title Launchpad Spaces Launcher
set "BASE_DIR=%~dp0"
set "TAILSCALE=C:\Program Files\Tailscale\tailscale.exe"
set "MANAGE_LAUNCHPAD_FUNNEL=0"
set "LAUNCHPAD_FUNNEL_PORT=8443"

cd /d "%BASE_DIR%"

if not exist "%BASE_DIR%package.json" (
    echo [ERROR] package.json was not found in:
    echo %BASE_DIR%
    echo Copy the complete Launchpad Tenant project into this folder.
    pause
    exit /b 1
)

findstr /I /C:"launchpad-tenant" "%BASE_DIR%package.json" >nul
if errorlevel 1 (
    echo [ERROR] This folder contains a different Node.js application.
    echo Expected package.json to identify the Launchpad Tenant project.
    echo The old Bayan Workforce backend must not be started from this folder.
    echo Copy the current Launchpad Tenant project files here first.
    pause
    exit /b 1
)

echo ==========================================
echo        LAUNCHPAD SPACES SERVER STARTUP
echo ==========================================
echo.

REM -------------------------------------------------
REM 1. Check XAMPP / MariaDB
REM -------------------------------------------------
echo [1/4] Checking MariaDB on port 3306...
netstat -ano | findstr ":3306" | findstr "LISTENING" >nul
if errorlevel 1 (
    echo [WARNING] MariaDB is NOT running on port 3306.
    echo Please start MySQL from the XAMPP Control Panel.
) else (
    echo [OK] MariaDB is running.
)
echo.

REM -------------------------------------------------
REM 2. Start the Launchpad Tenant backend
REM -------------------------------------------------
echo [2/4] Checking Launchpad Tenant backend on port 5177...
netstat -ano | findstr ":5177" | findstr "LISTENING" >nul
if errorlevel 1 (
    echo Starting Launchpad Tenant on port 5177...
    start "Launchpad Tenant" /min /D "%BASE_DIR%" cmd /k "npm.cmd start"
    timeout /t 4 /nobreak >nul
    netstat -ano | findstr ":5177" | findstr "LISTENING" >nul
    if errorlevel 1 (
        echo [ERROR] Launchpad Tenant did not start on port 5177.
        echo Check the Launchpad Tenant window for the startup error.
    ) else (
        echo [OK] Port 5177 is listening.
        curl.exe -fsS --max-time 3 http://127.0.0.1:5177/health 2>nul | findstr /I /C:"launchpad-tenant" /C:"tenant-booking" >nul
        if errorlevel 1 (
            echo [ERROR] Port 5177 is occupied, but it is not the Launchpad Tenant backend.
            echo Stop the old backend before continuing.
        ) else (
            echo [OK] Launchpad Tenant health check passed.
        )
    )
) else (
    echo [OK] Port 5177 is already listening.
    curl.exe -fsS --max-time 3 http://127.0.0.1:5177/health 2>nul | findstr /I /C:"launchpad-tenant" /C:"tenant-booking" >nul
    if errorlevel 1 (
        echo [ERROR] Port 5177 is occupied, but it is not the Launchpad Tenant backend.
        echo Stop the old backend before continuing.
    ) else (
        echo [OK] Launchpad Tenant health check passed.
    )
)
echo.

REM -------------------------------------------------
REM 3. Start the secure on-prem gateway
REM -------------------------------------------------
echo [3/4] Checking Launchpad Spaces gateway on port 6510...
netstat -ano | findstr ":6510" | findstr "LISTENING" >nul
if errorlevel 1 (
    echo Starting Launchpad Spaces gateway on port 6510...
    start "Launchpad Spaces Gateway" /min /D "%BASE_DIR%" cmd /k "npm.cmd run start:gateway"
    timeout /t 3 /nobreak >nul
    netstat -ano | findstr ":6510" | findstr "LISTENING" >nul
    if errorlevel 1 (
        echo [ERROR] Launchpad Spaces gateway did not start on port 6510.
        echo Check the gateway window and confirm RENDER_PROXY_SECRET is configured.
    ) else (
        echo [OK] Launchpad Spaces gateway is running on port 6510.
    )
) else (
    echo [OK] Launchpad Spaces gateway is already running on port 6510.
)
echo.

REM -------------------------------------------------
REM 4. Tailscale Funnel
REM -------------------------------------------------
echo [4/4] Checking Launchpad Spaces Tailscale Funnel...
if "%MANAGE_LAUNCHPAD_FUNNEL%"=="0" (
    echo [SKIP] Tailscale is managed by another process and was not modified.
    echo [INFO] Launchpad gateway is running locally on port 6510.
) else if not exist "%TAILSCALE%" (
    echo [ERROR] Tailscale was not found at:
    echo %TAILSCALE%
) else (
    "%TAILSCALE%" funnel status | findstr ":%LAUNCHPAD_FUNNEL_PORT%" >nul
    if errorlevel 1 (
        echo Launchpad Spaces Funnel not found. Starting it on port %LAUNCHPAD_FUNNEL_PORT%...
        "%TAILSCALE%" funnel --https=%LAUNCHPAD_FUNNEL_PORT% --bg 6510
    ) else (
        echo [OK] Launchpad Spaces Funnel is already configured on port %LAUNCHPAD_FUNNEL_PORT%.
    )
)
echo.

echo ==========================================
echo             CURRENT STATUS
echo ==========================================
echo.
if "%MANAGE_LAUNCHPAD_FUNNEL%"=="1" if exist "%TAILSCALE%" (
    "%TAILSCALE%" funnel status
)
echo.
if "%MANAGE_LAUNCHPAD_FUNNEL%"=="1" (
    echo Launchpad Spaces direct API gateway:
    echo https://coworking-system.tail06a199.ts.net:%LAUNCHPAD_FUNNEL_PORT%
) else (
    echo Tailscale Funnel was not changed because another process manages it.
    echo Confirm that Render ONPREM_BASE_URL points to the Launchpad gateway endpoint.
)
echo.
echo Launchpad Spaces Render site:
echo https://launchpadspace.onrender.com
echo.
echo ==========================================
echo Startup routine completed.
echo ==========================================
echo.

timeout /t 5 /nobreak >nul
endlocal
exit /b 0

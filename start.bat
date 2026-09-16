@echo off
REM ===========================================================================
REM  EngCoach - start the app
REM
REM  Double-click this file, or run `start.bat` from a terminal.
REM  It installs dependencies on first run, starts the dev server, and opens
REM  your browser. Close this window (or press Ctrl+C) to stop the server.
REM ===========================================================================

setlocal
cd /d "%~dp0"

echo.
echo   EngCoach
echo   ========
echo.

REM --- Node present? -------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo   [X] Node.js is not installed, or is not on your PATH.
    echo.
    echo       Install the LTS version from https://nodejs.org
    echo       then run this file again.
    echo.
    pause
    exit /b 1
)

REM Node 20+ is required (see package.json "engines").
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
    echo   [X] Node.js 20 or newer is required. You have:
    node -v
    echo.
    echo       Update from https://nodejs.org and run this file again.
    echo.
    pause
    exit /b 1
)

REM --- Dependencies --------------------------------------------------------
if not exist "node_modules" (
    echo   First run - installing dependencies. This takes a couple of minutes.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo   [X] npm install failed. Scroll up for the reason.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo   Dependencies installed.
    echo.
)

REM --- API keys (optional) -------------------------------------------------
if not exist ".env.local" (
    echo   No .env.local found - running in DEVELOPMENT MODE.
    echo.
    echo   The app works, but the coach uses scripted replies and your
    echo   browser's built-in voice. To get the real experience:
    echo.
    echo       copy .env.example .env.local
    echo.
    echo   then add your ANTHROPIC_API_KEY and restart.
    echo.
)

REM --- Go ------------------------------------------------------------------
echo   Starting the server on http://localhost:3000
echo   Your browser will open in a moment.
echo.
echo   Press Ctrl+C in this window to stop.
echo   ---------------------------------------------------------------
echo.

REM Open the browser after a short delay so the server is listening first.
REM `start ""` keeps this window as the one running the server.
start "" /b cmd /c "timeout /t 5 /nobreak >nul & start http://localhost:3000"

call npm run dev

REM npm run dev only returns once the server stops.
echo.
echo   Server stopped.
echo.
pause
endlocal

@echo off
REM ===========================================================================
REM  EngCoach - set up API keys
REM
REM  Creates .env.local from the template and opens it in Notepad so you can
REM  paste your keys in. Run start.bat afterwards.
REM ===========================================================================

setlocal
cd /d "%~dp0"

echo.
echo   EngCoach - API keys
echo   ===================
echo.

if exist ".env.local" (
    echo   .env.local already exists - opening it for editing.
    echo   Your existing keys are safe; nothing has been overwritten.
) else (
    copy /y ".env.example" ".env.local" >nul
    if errorlevel 1 (
        echo   [X] Could not create .env.local. Is .env.example missing?
        echo.
        pause
        exit /b 1
    )
    echo   Created .env.local from the template.
)

echo.
echo   Paste your keys next to the matching names, save, and close Notepad.
echo.
echo     ANTHROPIC_API_KEY   the coach itself - THIS IS THE ONE THAT MATTERS
echo                         https://console.anthropic.com/settings/keys
echo.
echo     DEEPGRAM_API_KEY    speech recognition with word timings (optional)
echo                         https://console.deepgram.com
echo.
echo     OPENAI_API_KEY      the coach's voice (optional)
echo                         https://platform.openai.com/api-keys
echo.
echo   Anything you leave blank falls back to a clearly-labelled
echo   development provider. The app still runs.
echo.

start /wait notepad ".env.local"

echo   Saved. Run start.bat to launch EngCoach.
echo.
pause
endlocal

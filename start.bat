@echo off
setlocal enabledelayedexpansion
title Fund reporting
rem ---------------------------------------------------------------------------
rem  Start the application on Windows.
rem
rem  Double-click this file. Nothing needs to be typed, here or anywhere else.
rem  It brings the code up to date, installs anything new, opens the browser and
rem  starts the server. Closing this window stops it.
rem
rem  It stops at the browser on purpose. The folder permission and the
rem  passphrase are asked for on every load, and a script that remembered
rem  either would defeat the thing it is protecting.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

echo.
echo   ================================================
echo    Fund reporting
echo   ================================================
echo.

rem What is running now, so the update below can say whether anything changed.
for /f "delims=" %%v in ('git rev-parse --short HEAD 2^>nul') do set BEFORE=%%v

echo   [1/3] Looking for a newer version...
git pull --ff-only >"%TEMP%\fr-pull.txt" 2>&1
if errorlevel 1 (
  echo         Could not check. The version you already have still runs.
  echo         ^(Usually this means no internet, or a file here was edited by hand.^)
) else (
  for /f "delims=" %%v in ('git rev-parse --short HEAD 2^>nul') do set AFTER=%%v
  if "!BEFORE!"=="!AFTER!" (
    echo         Already up to date ^(version !AFTER!^).
  ) else (
    echo         Updated: !BEFORE! -^> !AFTER!
  )
)

echo   [2/3] Checking the pieces it needs...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo.
  echo         Something went wrong installing. Send this window to Claude.
  echo.
  pause
  exit /b 1
)
echo         Ready.

rem The server takes over this window, so the browser is opened from a second
rem one that waits for it to be listening first.
start "" cmd /c "timeout /t 6 /nobreak >nul & start "" http://localhost:5173/"

echo   [3/3] Starting. The browser opens in a few seconds.
echo.
echo   ------------------------------------------------
echo    Then, in the browser:
echo      Storage  -^>  Reconnect  -^>  your passphrase
echo.
echo    Leave this window open while you work.
echo    Close it when you are done.
echo   ------------------------------------------------
echo.

call npm run dev

rem If the server stops on its own, say so rather than vanishing.
echo.
echo   The server has stopped. You can close this window.
pause

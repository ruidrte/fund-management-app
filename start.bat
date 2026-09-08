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
  echo         Git said:
  rem Its own words, indented. A message naming the cause is worth more than a
  rem guess at it: "could not check" with no reason sends somebody hunting
  rem through their internet connection when the answer was a sign-in prompt.
  for /f "usebackq delims=" %%l in ("%TEMP%\fr-pull.txt") do echo           %%l
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

rem Chrome or Edge, opened in application mode: its own window, no tab strip,
rem no address bar. The application is not a page somebody browses to among
rem twenty others; it holds a client's book, and a window that looks like a
rem window is harder to close by accident and easier to find again.
rem
rem Found by where they install rather than by asking the shell, because
rem neither puts itself on PATH. Neither present, the default browser opens it
rem as an ordinary tab, which works and says nothing about it.
set "BROWSER="
for %%b in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%b set "BROWSER=%%~b"

rem The server takes over this window, so the browser is opened from a second
rem one that waits for it to be listening first.
if defined BROWSER (
  start "" cmd /c timeout /t 6 /nobreak ^>nul ^& start "" "%BROWSER%" --app=http://localhost:5173/
) else (
  start "" cmd /c timeout /t 6 /nobreak ^>nul ^& start "" http://localhost:5173/
)

echo   [3/3] Starting. The browser opens in a few seconds.
echo.
echo   ------------------------------------------------
echo    Then, in the window that opens:
echo      Storage  -^>  Reconnect  -^>  your passphrase
echo.
echo    Chrome offers to save the passphrase the first time. Say yes and it
echo    fills it in from then on; it is kept by Chrome, not by this.
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

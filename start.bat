@echo off
rem ---------------------------------------------------------------------------
rem  Start the application on Windows.
rem
rem  Double-click this file. It brings the code up to date, installs anything
rem  new, opens the browser and starts the server. Ctrl+C in this window stops
rem  it; closing the window does too.
rem
rem  It deliberately does not touch your book. The folder permission and the
rem  passphrase are asked for in the browser every time, which is the property
rem  that makes an encrypted folder worth encrypting.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

echo.
echo  Updating...
git pull --ff-only
if errorlevel 1 (
  echo.
  echo  Could not update. Usually this means a file here was edited by hand;
  echo  the version you already have still runs. Carrying on.
)

echo.
echo  Checking dependencies...
call npm install --no-audit --no-fund --loglevel=error

rem The server is about to take over this window, so the browser is opened from
rem a second one that waits for the server to be listening first.
start "" cmd /c "timeout /t 6 /nobreak >nul & start "" http://localhost:5173/"

echo.
echo  Starting. The browser opens in a few seconds.
echo  Then: Storage - Reconnect - passphrase.
echo.
call npm run dev

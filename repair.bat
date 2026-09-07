@echo off
setlocal
title Fund reporting - repair
rem ---------------------------------------------------------------------------
rem  Put the code back exactly as it is on GitHub.
rem
rem  For when files have gone missing or been changed by something other than
rem  you - a sync client, an interrupted download, an editor saving over
rem  something. It throws away whatever is here and fetches a clean copy of
rem  every file.
rem
rem  It does NOT touch your book. Your data lives in the folder you chose under
rem  Storage, which is somewhere else and is never part of this.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

echo.
echo   ================================================
echo    Fund reporting - repair
echo   ================================================
echo.
echo   This replaces every file here with a clean copy from GitHub.
echo   Anything edited by hand in this folder is lost.
echo.
echo   Your book - the folder with your data - is not touched.
echo.
pause

echo.
echo   [1/3] Fetching a clean copy...
git fetch origin
if errorlevel 1 (
  echo.
  echo         Could not reach GitHub. If a sign-in window opened, complete it
  echo         and run this again. Send this window to Claude otherwise.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set BRANCH=%%b
if not defined BRANCH set BRANCH=claude/fof-reporting-monitoring-app-1ry1et

echo   [2/3] Putting every file back as it is on %BRANCH%...
git checkout -B "%BRANCH%" "origin/%BRANCH%"
if errorlevel 1 goto :failed
git reset --hard "origin/%BRANCH%"
if errorlevel 1 goto :failed

rem The thing that was missing, checked for by name rather than assumed.
if not exist "src\main.tsx" goto :failed
echo         The files are back.

echo   [3/3] Checking the pieces it needs...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo.
  echo         Something went wrong installing. Send this window to Claude.
  echo.
  pause
  exit /b 1
)

echo.
echo   ------------------------------------------------
echo    Repaired. Close this window and double-click
echo    start.bat as usual.
echo   ------------------------------------------------
echo.
pause
exit /b 0

:failed
echo.
echo         The files could not be put back. This usually means something
echo         else is holding on to them - OneDrive, Dropbox, or an open
echo         editor. A folder that a sync client watches is not a good place
echo         to keep this; somewhere like C:\dev is.
echo.
pause
exit /b 1

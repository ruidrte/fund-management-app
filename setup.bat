@echo off
setlocal enabledelayedexpansion
title Fund reporting - first-time setup
rem ---------------------------------------------------------------------------
rem  Set the application up on a computer that has never run it.
rem
rem  Double-click this file. It checks the two things Windows needs, copies the
rem  code down, and hands over to start.bat, which is what you use every day
rem  after this. Nothing needs to be typed.
rem
rem  Run it once per computer. Running it again on a machine that already has
rem  the code is harmless: it says so and starts the application.
rem ---------------------------------------------------------------------------

set REPO=https://github.com/ruidrte/fund-management-app.git
set BRANCH=claude/fof-reporting-monitoring-app-1ry1et
set FOLDER=fund-management-app

echo.
echo   ================================================
echo    Fund reporting - first-time setup
echo   ================================================
echo.

rem --- the two things Windows has to have --------------------------------
echo   [1/4] Checking what this computer already has...

where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo         Git is not installed. It is what fetches the code and what
  echo         keeps it up to date afterwards.
  echo.
  echo         Install it from   https://git-scm.com/download/win
  echo         The default options are right. Then run this file again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo.
  echo         Node is not installed. It is what runs the application.
  echo.
  echo         Install the LTS version from   https://nodejs.org
  echo         The default options are right. Then run this file again.
  echo.
  pause
  exit /b 1
)
echo         Git and Node are both here.

rem --- where it goes -----------------------------------------------------
cd /d "%~dp0"
echo   [2/4] Putting it in "%CD%\%FOLDER%"...

if exist "%FOLDER%\.git" (
  if exist "%FOLDER%\src\main.tsx" (
    echo         Already here. Nothing to copy down.
    goto :ready
  )
  echo.
  echo         There is a half-finished copy here: the hidden .git folder
  echo         arrived and the files did not.
  echo.
  echo         Delete the "%FOLDER%" folder and run this file again.
  echo.
  pause
  exit /b 1
)

if exist "%FOLDER%" (
  echo.
  echo         There is already a folder called "%FOLDER%" here and it is not
  echo         a copy of the code. Move or rename it, then run this again.
  echo.
  pause
  exit /b 1
)

echo   [3/4] Copying the code down. This takes a minute...
git clone --branch %BRANCH% %REPO% "%FOLDER%"
if errorlevel 1 (
  echo.
  echo         That did not work. The usual reasons are no internet, or this
  echo         computer not being signed in to GitHub.
  echo         Send this window to Claude.
  echo.
  pause
  exit /b 1
)
echo         Done.

rem A clone can return success and still leave nothing behind - an interrupted
rem checkout, a sign-in that was closed, a disk that filled. Nothing downstream
rem notices: npm install says "up to date" over an empty folder in half a
rem second, and the first thing that complains is the dev server, about a file
rem nobody has heard of. So the thing that was supposed to arrive is checked
rem for by name.
if not exist "%FOLDER%\src\main.tsx" (
  echo.
  echo         The download finished but the files are not here - only the
  echo         hidden .git folder arrived. Usually a sign-in window was closed
  echo         or the connection dropped part way.
  echo.
  echo         Delete the "%FOLDER%" folder and run this file again.
  echo.
  pause
  exit /b 1
)

:ready
echo   [4/4] Handing over to start.bat, which is what you use from now on.
echo.
echo   ------------------------------------------------
echo    From today, to open the application:
echo      go into  %FOLDER%  and double-click  start.bat
echo.
echo    You will still need to point it at your book:
echo      Storage  -^>  Choose a folder  -^>  where your data lives
echo   ------------------------------------------------
echo.
pause

cd /d "%CD%\%FOLDER%"
call start.bat

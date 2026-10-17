@echo off
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
set PIP_DISABLE_PIP_VERSION_CHECK=1
cd /d "%~dp0"
title Farida Song Browser
if exist ".venv\Scripts\python.exe" goto dependencies
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -m venv .venv
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Please install Python 3.10 or newer from https://www.python.org/downloads/windows/
    echo During installation, select "Add Python to PATH", then open this launcher again.
    pause
    exit /b 1
  )
  python -m venv .venv
)
if errorlevel 1 goto failure
:dependencies
".venv\Scripts\python.exe" -X utf8 -c "import fastapi,httpx,uvicorn,pydantic,segno,wsproto; assert int(pydantic.__version__.split('.')[0]) >= 2" >nul 2>nul
if not errorlevel 1 goto launch
echo Installing the small Python dependencies. This is needed only on first launch.
".venv\Scripts\python.exe" -X utf8 -m pip install --quiet --no-warn-script-location -r requirements.txt
if errorlevel 1 goto failure
:launch
".venv\Scripts\python.exe" -X utf8 run.py
if errorlevel 1 goto failure
exit /b 0
:failure
echo.
echo Farida could not start. Please copy the error above for troubleshooting.
pause
exit /b 1

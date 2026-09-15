@echo off
REM Serve the dashboard locally. The page uses fetch() for its data, which the
REM browser blocks on file:// URLs, so it has to go over HTTP even locally.
cd /d "%~dp0"
echo Dashboard: http://localhost:8765
python -m http.server 8765 --directory web

@echo off
REM Serve the dashboard locally. The page uses fetch() for its data, which the
REM browser blocks on file:// URLs, so it has to go over HTTP even locally.
REM
REM Port 8771, not 8765: another project on the original dev machine holds 8765.
REM If 8771 is busy too, change it here AND in .claude/launch.json -- that file
REM repeats the port in runtimeArgs, and a mismatch makes the preview start a
REM server on one port while the browser opens the other.
cd /d "%~dp0"
echo Dashboard: http://localhost:8771
python -m http.server 8771 --directory web

@echo off
:: Navigate to your project folder
cd /d "C:\Users\IT Admin\Documents\vigilance-bridge"

echo --- Bridge Started at %date% %time% --- >> output.log

:loop
:: Run the script and pipe all terminal text and errors into output.log
node bridge.js >> output.log 2>&1

:: If the script ever crashes or exits, the batch file will catch it here
echo ❌ Script crashed or stopped. Restarting in 5 seconds... >> output.log
timeout /t 5 > nul
goto loop
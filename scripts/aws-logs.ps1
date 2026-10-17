# Live API log from the AWS server: one line per request from the app and the admin portal.
# Usage (from this folder's parent):  npm run logs:aws      or      powershell -File scripts/aws-logs.ps1 -Lines 100
# Stop with Ctrl+C. Needs the key at ~/.ssh/ai-fitness.pem and SSH allowed from your current IP.
param([int]$Lines = 50)

$key = Join-Path $env:USERPROFILE '.ssh\ai-fitness.pem'
ssh -i $key -o ServerAliveInterval=30 ubuntu@16.176.190.24 "tail -n $Lines -F ~/.pm2/logs/ai-fitness-out.log ~/.pm2/logs/ai-fitness-error.log"

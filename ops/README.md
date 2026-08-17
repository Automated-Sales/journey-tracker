# Ops scripts

These scripts run on the droplet (attribution-tracker), not as part of
the app build. They're kept here so they survive a droplet rebuild.

## backup-journey-tracker.sh
Backs up the sql.js tenants.db to /root/backups/journey-tracker/,
compresses it, and prunes anything older than 14 days.

Installed on the droplet via crontab, running daily at 03:00 UTC:
0 3 * * * /root/backup-journey-tracker.sh >> /root/backup-journey-tracker.log 2>&1

To reinstall on a fresh droplet: copy this script to /root/, chmod +x it,
then re-add the crontab line above.

## Swap file (added 17 Aug 2026)

This droplet only has 458MB RAM and shipped with zero swap configured — during a deploy on 17 Aug, npm install && npm run build running alongside the live app appears to have interrupted the build (tsc never finished writing dist/index.js), which left pm2 trying to launch a script that didn't exist. It failed and restarted in a tight loop thousands of times a minute, pegging CPU and taking the whole droplet (SSH included) offline until a manual reboot + rebuild fixed it.

A 1GB swap file was added the same day as a safety net against this class of problem recurring — it won't prevent a bad build, but it gives the system room to avoid the memory-exhaustion spiral that made this incident so much worse than a simple "app is down."

Current setup:
- File: /swapfile, 1GB, chmod 600
- Persisted in /etc/fstab: /swapfile none swap sw 0 0
- vm.swappiness=10 set in /etc/sysctl.conf (prefer RAM, only swap under real pressure — appropriate for a small droplet)

To verify it's active:
swapon --show
free -h
Should show /swapfile with Swap: around 1.0Gi.

To reinstall on a fresh droplet (if this one is ever rebuilt):
fallocate -l 1G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' | tee -a /etc/fstab
sysctl vm.swappiness=10
echo 'vm.swappiness=10' | tee -a /etc/sysctl.conf

Bigger-picture note for next time: running npm install && npm run build directly on this droplet is inherently risky given how little RAM headroom it has. Worth considering building dist/ elsewhere (a sandbox, CI, or locally) and only shipping the compiled output to the droplet in future deploys, to avoid repeating this failure mode entirely rather than just cushioning it with swap.

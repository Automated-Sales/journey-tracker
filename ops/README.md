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

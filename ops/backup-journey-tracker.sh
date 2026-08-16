#!/bin/bash
set -e

SRC="/root/journey-tracker-data/tenants.db"
DEST_DIR="/root/backups/journey-tracker"
TIMESTAMP=$(date +%Y-%m-%d-%H%M)
DEST="$DEST_DIR/tenants-$TIMESTAMP.db"

mkdir -p "$DEST_DIR"

# Atomic, safe-for-live-writes backup via sqlite3's own .backup command
sqlite3 "$SRC" ".backup '$DEST'"

# Compress to save space
gzip "$DEST"

# Keep last 14 days, delete anything older
find "$DEST_DIR" -name "tenants-*.db.gz" -mtime +14 -delete

echo "Backup complete: $DEST.gz"

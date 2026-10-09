-- Add remote pause switch (safe to skip if the column already exists)
ALTER TABLE settings ADD COLUMN alerts_enabled INTEGER NOT NULL DEFAULT 1;

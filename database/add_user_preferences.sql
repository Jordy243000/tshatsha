-- Add user preferences columns to users table
-- These columns will store user settings for privacy, notifications, etc.

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS preferences JSON DEFAULT NULL AFTER favorite_genre;

-- Alternative if IF NOT EXISTS is not supported:
-- Check if column exists first, then add if needed
-- The migration script will handle this


-- Add profile fields to users table
-- Note: Execute these statements one by one if column already exists, MySQL will throw an error
-- You can ignore the error if the column already exists

ALTER TABLE users ADD COLUMN bio TEXT AFTER avatar_url;
ALTER TABLE users ADD COLUMN location VARCHAR(255) AFTER bio;
ALTER TABLE users ADD COLUMN favorite_genre VARCHAR(100) AFTER location;


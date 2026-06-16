-- Add date_of_birth column to users table
-- Run this script if the column doesn't exist yet

-- For MySQL, we need to check if column exists first
-- If you get an error that the column already exists, you can ignore it

ALTER TABLE users 
ADD COLUMN date_of_birth DATE AFTER full_name;

-- Migration: Allow password_hash to be NULL for OAuth users
-- Run this if your database already exists and password_hash is NOT NULL

USE TshaTshaStream_db;

ALTER TABLE users MODIFY COLUMN password_hash VARCHAR(255) NULL;


-- TshaTshaStream Database Schema
-- MySQL Database: TshaTshaStream_db

-- Create database if not exists
CREATE DATABASE IF NOT EXISTS TshaTshaStream_db;
USE TshaTshaStream_db;

-- Users table (extends auth system)
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  full_name VARCHAR(255),
  date_of_birth DATE,
  avatar_url TEXT,
  billing_address JSON,
  payment_method JSON,
  is_artist BOOLEAN DEFAULT FALSE,
  artist_id VARCHAR(36),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_artist_id (artist_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Music tracks table
CREATE TABLE IF NOT EXISTS music (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  artist_name VARCHAR(255) NOT NULL,
  audio_url TEXT NOT NULL,
  image_url TEXT,
  is_premium BOOLEAN DEFAULT FALSE,
  is_trending BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_artist (artist_name),
  INDEX idx_trending (is_trending),
  INDEX idx_premium (is_premium),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Artists table
CREATE TABLE IF NOT EXISTS artists (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  bio TEXT,
  image_url TEXT,
  cover_image_url TEXT,
  genre VARCHAR(100),
  country VARCHAR(100),
  verified BOOLEAN DEFAULT FALSE,
  monthly_listeners INT DEFAULT 0,
  total_plays INT DEFAULT 0,
  is_popular BOOLEAN DEFAULT FALSE,
  social_links JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_name (name),
  INDEX idx_popular (is_popular)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Albums table
CREATE TABLE IF NOT EXISTS albums (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  artist_name VARCHAR(255) NOT NULL,
  description TEXT,
  cover_image_url TEXT,
  release_date DATE,
  genre VARCHAR(100),
  status ENUM('pending', 'approved', 'rejected') DEFAULT 'approved',
  submitted_by VARCHAR(36),
  is_popular BOOLEAN DEFAULT FALSE,
  is_paid_release BOOLEAN DEFAULT FALSE,
  paid_price_usd DECIMAL(5,2) NULL,
  paid_window_days INT DEFAULT 14,
  is_preorder_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_artist (artist_name),
  INDEX idx_release (release_date),
  INDEX idx_status (status),
  INDEX idx_is_popular (is_popular),
  INDEX idx_is_paid_release (is_paid_release)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Album purchases (temporary paid access + ownership)
CREATE TABLE IF NOT EXISTS album_purchases (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  album_id VARCHAR(36) NOT NULL,
  price_usd DECIMAL(5,2) NOT NULL,
  purchase_type ENUM('purchase', 'preorder') DEFAULT 'purchase',
  purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
  UNIQUE KEY unique_album_purchase (user_id, album_id),
  INDEX idx_album (album_id),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Album preorders
CREATE TABLE IF NOT EXISTS album_preorders (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  album_id VARCHAR(36) NOT NULL,
  price_usd DECIMAL(5,2) NOT NULL,
  status ENUM('active', 'converted', 'canceled') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
  UNIQUE KEY unique_album_preorder (user_id, album_id),
  INDEX idx_album (album_id),
  INDEX idx_user (user_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Album tracks (many-to-many relationship)
CREATE TABLE IF NOT EXISTS album_tracks (
  id VARCHAR(36) PRIMARY KEY,
  album_id VARCHAR(36) NOT NULL,
  track_id VARCHAR(36) NOT NULL,
  position INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES music(id) ON DELETE CASCADE,
  UNIQUE KEY unique_album_track (album_id, track_id),
  INDEX idx_album (album_id),
  INDEX idx_track (track_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Playlists table
CREATE TABLE IF NOT EXISTS playlists (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  user_id VARCHAR(36) NOT NULL,
  image_url TEXT,
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user (user_id),
  INDEX idx_public (is_public)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Playlist tracks (many-to-many relationship)
CREATE TABLE IF NOT EXISTS playlist_tracks (
  id VARCHAR(36) PRIMARY KEY,
  playlist_id VARCHAR(36) NOT NULL,
  track_id VARCHAR(36) NOT NULL,
  position INT NOT NULL,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES music(id) ON DELETE CASCADE,
  UNIQUE KEY unique_playlist_track (playlist_id, track_id),
  INDEX idx_playlist (playlist_id),
  INDEX idx_track (track_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Liked songs table
CREATE TABLE IF NOT EXISTS liked_song (
  user_id VARCHAR(36) NOT NULL,
  song_id VARCHAR(36) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, song_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id) REFERENCES music(id) ON DELETE CASCADE,
  INDEX idx_user (user_id),
  INDEX idx_song (song_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL UNIQUE,
  status ENUM('trialing', 'active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid') DEFAULT 'incomplete',
  price_id VARCHAR(255),
  quantity INT DEFAULT 1,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  current_period_start TIMESTAMP,
  current_period_end TIMESTAMP,
  ended_at TIMESTAMP NULL,
  cancel_at TIMESTAMP NULL,
  canceled_at TIMESTAMP NULL,
  trial_start TIMESTAMP NULL,
  trial_end TIMESTAMP NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user (user_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- User usage tracking (for free users)
CREATE TABLE IF NOT EXISTS user_usage (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL UNIQUE,
  plays_count INT DEFAULT 0,
  skips_count INT DEFAULT 0,
  last_reset TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Listening history
CREATE TABLE IF NOT EXISTS listening_history (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  track_id VARCHAR(36) NOT NULL,
  played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES music(id) ON DELETE CASCADE,
  INDEX idx_user (user_id),
  INDEX idx_track (track_id),
  INDEX idx_played_at (played_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Stream counting guard: one counted stream per user/track every 24h
CREATE TABLE IF NOT EXISTS user_track_streams (
  user_id VARCHAR(36) NOT NULL,
  track_id VARCHAR(36) NOT NULL,
  last_counted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  total_counted INT NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, track_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES music(id) ON DELETE CASCADE,
  INDEX idx_last_counted (last_counted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Publicités : sélection admin (si la table est vide → toutes les pubs S3 dossier pub/)
CREATE TABLE IF NOT EXISTS ads_config (
  audio_url VARCHAR(700) NOT NULL PRIMARY KEY,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ads_enabled_order (is_enabled, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Comptage des lectures de pub terminées (fin de piste)
CREATE TABLE IF NOT EXISTS ad_play_events (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  audio_url TEXT NOT NULL,
  user_id VARCHAR(36) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ad_plays_created (created_at),
  INDEX idx_ad_plays_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Concerts table
CREATE TABLE IF NOT EXISTS concerts (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  artist VARCHAR(255) NOT NULL,
  artist_id VARCHAR(36) NULL,
  venue VARCHAR(255) NOT NULL,
  city VARCHAR(255) NOT NULL,
  date DATE NOT NULL,
  time TIME NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'CDF',
  image_url TEXT,
  genre VARCHAR(100),
  capacity INT NOT NULL,
  sold_tickets INT DEFAULT 0,
  rating DECIMAL(3, 2) DEFAULT 0.0,
  description TEXT,
  is_popular BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_artist_id (artist_id),
  INDEX idx_active (is_active),
  INDEX idx_date (date),
  INDEX idx_popular (is_popular)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Artist applications table
CREATE TABLE IF NOT EXISTS artist_applications (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  artist_name VARCHAR(255) NOT NULL,
  real_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  identity_document_url TEXT NOT NULL,
  facebook_url TEXT,
  instagram_url TEXT,
  twitter_url TEXT,
  youtube_url TEXT,
  spotify_url TEXT,
  bio TEXT,
  status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
  rejection_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user (user_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Artist follows table
CREATE TABLE IF NOT EXISTS artist_follows (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  artist_id VARCHAR(36) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE,
  UNIQUE KEY unique_follow (user_id, artist_id),
  INDEX idx_user (user_id),
  INDEX idx_artist (artist_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Album likes table
CREATE TABLE IF NOT EXISTS album_likes (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  album_id VARCHAR(36) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
  UNIQUE KEY unique_album_like (user_id, album_id),
  INDEX idx_user (user_id),
  INDEX idx_album (album_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Trigger to reset user usage daily
-- Note: This trigger is commented out as it requires special DELIMITER handling
-- The reset logic can be handled in the application code instead
-- DELIMITER //
-- CREATE TRIGGER IF NOT EXISTS reset_usage_if_needed
-- BEFORE UPDATE ON user_usage
-- FOR EACH ROW
-- BEGIN
--   IF TIMESTAMPDIFF(HOUR, NEW.last_reset, NOW()) >= 24 THEN
--     SET NEW.plays_count = 0;
--     SET NEW.skips_count = 0;
--     SET NEW.last_reset = NOW();
--   END IF;
-- END//
-- DELIMITER ;


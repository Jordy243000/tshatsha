-- Script SQL pour insérer les données mockées dans MySQL
-- Utilisation: mysql -u root -p TshaTshaStream_db < seedData.sql

USE TshaTshaStream_db;

-- Supprimer les données existantes (optionnel - décommentez si vous voulez réinitialiser)
-- DELETE FROM album_tracks;
-- DELETE FROM playlist_tracks;
-- DELETE FROM liked_song;
-- DELETE FROM listening_history;
-- DELETE FROM music;
-- DELETE FROM albums;
-- DELETE FROM artists;

-- Insérer les pistes
INSERT INTO music (id, title, artist_name, audio_url, image_url, is_premium, is_trending, created_at) VALUES
('550e8400-e29b-41d4-a716-446655440001', 'Hit du Moment', 'Artiste Populaire', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', 'https://via.placeholder.com/300x300/8b5cf6/ffffff?text=Hit', 0, 1, NOW()),
('550e8400-e29b-41d4-a716-446655440002', 'Rythme Africain', 'Star Africaine', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', 'https://via.placeholder.com/300x300/1DB954/ffffff?text=Music', 0, 1, NOW()),
('550e8400-e29b-41d4-a716-446655440003', 'Vibration Urbaine', 'MC Local', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', 'https://via.placeholder.com/300x300/ff6b6b/ffffff?text=Beat', 1, 1, NOW()),
('550e8400-e29b-41d4-a716-446655440004', 'Mélodie Douce', 'Chanteur Talent', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3', 'https://via.placeholder.com/300x300/4ecdc4/ffffff?text=Song', 0, 1, NOW()),
('550e8400-e29b-41d4-a716-446655440005', 'Énergie Pure', 'DJ Dynamique', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3', 'https://via.placeholder.com/300x300/ffe66d/000000?text=Energy', 0, 1, NOW()),
('550e8400-e29b-41d4-a716-446655440006', 'Soul Authentique', 'Voix Profonde', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3', 'https://via.placeholder.com/300x300/95e1d3/ffffff?text=Soul', 0, 1, NOW()),
('550e8400-e29b-41d4-a716-446655440007', 'Fusion Moderne', 'Groupe Innovant', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3', 'https://via.placeholder.com/300x300/f38181/ffffff?text=Fusion', 1, 1, NOW()),
('550e8400-e29b-41d4-a716-446655440008', 'Vibes Tropicales', 'Artiste Caribéen', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3', 'https://via.placeholder.com/300x300/a8e6cf/ffffff?text=Island', 0, 1, NOW())
ON DUPLICATE KEY UPDATE title=VALUES(title);

-- Insérer les artistes
INSERT INTO artists (id, name, bio, image_url, verified, monthly_listeners, is_popular, created_at, updated_at) VALUES
('660e8400-e29b-41d4-a716-446655440001', 'Artiste Populaire', 'Artiste de renommée internationale', 'https://via.placeholder.com/300x300/8b5cf6/ffffff?text=Artist', 1, 125000, 1, NOW(), NOW()),
('660e8400-e29b-41d4-a716-446655440002', 'Star Africaine', 'Talent émergent du continent', 'https://via.placeholder.com/300x300/1DB954/ffffff?text=Star', 1, 98000, 1, NOW(), NOW()),
('660e8400-e29b-41d4-a716-446655440003', 'MC Local', 'Rappeur de la scène locale', 'https://via.placeholder.com/300x300/ff6b6b/ffffff?text=MC', 0, 45000, 1, NOW(), NOW()),
('660e8400-e29b-41d4-a716-446655440004', 'Chanteur Talent', 'Voix exceptionnelle', 'https://via.placeholder.com/300x300/4ecdc4/ffffff?text=Singer', 1, 78000, 1, NOW(), NOW()),
('660e8400-e29b-41d4-a716-446655440005', 'DJ Dynamique', 'DJ résident des meilleures soirées', 'https://via.placeholder.com/300x300/ffe66d/000000?text=DJ', 0, 32000, 1, NOW(), NOW()),
('660e8400-e29b-41d4-a716-446655440006', 'Voix Profonde', 'Artiste soul reconnu', 'https://via.placeholder.com/300x300/95e1d3/ffffff?text=Voice', 1, 156000, 1, NOW(), NOW())
ON DUPLICATE KEY UPDATE name=VALUES(name);

-- Insérer les albums
INSERT INTO albums (id, title, artist_name, cover_image_url, release_date, genre, description, created_at, updated_at) VALUES
('770e8400-e29b-41d4-a716-446655440001', 'Collection 2024', 'Artiste Populaire', 'https://via.placeholder.com/400x400/8b5cf6/ffffff?text=Album1', '2024-01-15', 'Pop', 'Album phare de l\'année', NOW(), NOW()),
('770e8400-e29b-41d4-a716-446655440002', 'Rythmes Africains', 'Star Africaine', 'https://via.placeholder.com/400x400/1DB954/ffffff?text=Album2', '2024-02-20', 'Afrobeat', 'Fusion de rythmes traditionnels et modernes', NOW(), NOW()),
('770e8400-e29b-41d4-a716-446655440003', 'Vibes Urbaines', 'MC Local', 'https://via.placeholder.com/400x400/ff6b6b/ffffff?text=Album3', '2024-03-10', 'Hip-Hop', 'L\'essence du rap local', NOW(), NOW()),
('770e8400-e29b-41d4-a716-446655440004', 'Mélodies Éternelles', 'Chanteur Talent', 'https://via.placeholder.com/400x400/4ecdc4/ffffff?text=Album4', '2024-01-05', 'Ballad', 'Des ballades intemporelles', NOW(), NOW()),
('770e8400-e29b-41d4-a716-446655440005', 'Énergie Pure', 'DJ Dynamique', 'https://via.placeholder.com/400x400/ffe66d/000000?text=Album5', '2024-02-28', 'Electronic', 'Mix énergique pour danser', NOW(), NOW()),
('770e8400-e29b-41d4-a716-446655440006', 'Soul Sessions', 'Voix Profonde', 'https://via.placeholder.com/400x400/95e1d3/ffffff?text=Album6', '2023-12-15', 'Soul', 'Sessions live enregistrées', NOW(), NOW())
ON DUPLICATE KEY UPDATE title=VALUES(title);

-- Lier les pistes aux albums (album_tracks)
-- Collection 2024
INSERT INTO album_tracks (id, album_id, track_id, position) VALUES
('880e8400-e29b-41d4-a716-446655440001', '770e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440001', 1)
ON DUPLICATE KEY UPDATE position=VALUES(position);

-- Rythmes Africains
INSERT INTO album_tracks (id, album_id, track_id, position) VALUES
('880e8400-e29b-41d4-a716-446655440002', '770e8400-e29b-41d4-a716-446655440002', '550e8400-e29b-41d4-a716-446655440002', 1)
ON DUPLICATE KEY UPDATE position=VALUES(position);

-- Vibes Urbaines
INSERT INTO album_tracks (id, album_id, track_id, position) VALUES
('880e8400-e29b-41d4-a716-446655440003', '770e8400-e29b-41d4-a716-446655440003', '550e8400-e29b-41d4-a716-446655440003', 1)
ON DUPLICATE KEY UPDATE position=VALUES(position);

-- Mélodies Éternelles
INSERT INTO album_tracks (id, album_id, track_id, position) VALUES
('880e8400-e29b-41d4-a716-446655440004', '770e8400-e29b-41d4-a716-446655440004', '550e8400-e29b-41d4-a716-446655440004', 1)
ON DUPLICATE KEY UPDATE position=VALUES(position);

-- Énergie Pure
INSERT INTO album_tracks (id, album_id, track_id, position) VALUES
('880e8400-e29b-41d4-a716-446655440005', '770e8400-e29b-41d4-a716-446655440005', '550e8400-e29b-41d4-a716-446655440005', 1)
ON DUPLICATE KEY UPDATE position=VALUES(position);

-- Soul Sessions
INSERT INTO album_tracks (id, album_id, track_id, position) VALUES
('880e8400-e29b-41d4-a716-446655440006', '770e8400-e29b-41d4-a716-446655440006', '550e8400-e29b-41d4-a716-446655440006', 1)
ON DUPLICATE KEY UPDATE position=VALUES(position);

SELECT '✅ Données insérées avec succès!' as message;
SELECT COUNT(*) as total_tracks FROM music;
SELECT COUNT(*) as total_artists FROM artists;
SELECT COUNT(*) as total_albums FROM albums;


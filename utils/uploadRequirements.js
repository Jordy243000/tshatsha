import { imageSize } from 'image-size';

export const AUDIO_MAX_BYTES = 100 * 1024 * 1024;
export const COVER_SIZE_PX = 2000;
export const ALLOWED_SAMPLE_RATES = [44100, 48000];
export const ALLOWED_BIT_DEPTHS = [16, 24];

export const AUDIO_REQUIREMENTS_HINT =
  'WAV obligatoire — 16 ou 24 bits, 44,1 ou 48 kHz, 100 Mo max.';
export const COVER_REQUIREMENTS_HINT =
  'Cover obligatoire — 2000 × 2000 px (JPG ou PNG).';

export const multerAudioLimit = { fileSize: AUDIO_MAX_BYTES };

export function isWavFile(file) {
  if (!file) return false;
  const name = String(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  const wavMimes = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'];
  return name.endsWith('.wav') || wavMimes.includes(mime);
}

export function isJpgOrPngImage(file) {
  if (!file) return false;
  const name = String(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png'];
  return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || allowedMimes.includes(mime);
}

export function validateWavBuffer(buffer) {
  if (!buffer || buffer.length < 44) {
    throw new Error('Fichier WAV invalide ou incomplet');
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Le fichier doit être au format WAV');
  }
  const audioFormat = buffer.readUInt16LE(20);
  if (audioFormat !== 1) {
    throw new Error('Le WAV doit être en PCM (non compressé)');
  }
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  if (!ALLOWED_SAMPLE_RATES.includes(sampleRate)) {
    throw new Error('Fréquence d\'échantillonnage : 44,1 ou 48 kHz uniquement');
  }
  if (!ALLOWED_BIT_DEPTHS.includes(bitsPerSample)) {
    throw new Error('Profondeur audio : 16 ou 24 bits uniquement');
  }
}

export function validateAudioFile(file) {
  if (!file?.buffer) throw new Error('Fichier audio manquant');
  if (file.size > AUDIO_MAX_BYTES) {
    throw new Error(`Fichier audio trop volumineux (max ${AUDIO_MAX_BYTES / (1024 * 1024)} Mo)`);
  }
  if (!isWavFile(file)) {
    throw new Error('Le format audio WAV (.wav) est obligatoire');
  }
  validateWavBuffer(file.buffer);
}

export function validateCoverDimensions(file, size = COVER_SIZE_PX) {
  if (!file?.buffer) throw new Error('Cover manquante');
  if (!isJpgOrPngImage(file)) {
    throw new Error('La cover doit être au format JPG ou PNG');
  }
  const dimensions = imageSize(file.buffer);
  if (dimensions.width !== size || dimensions.height !== size) {
    throw new Error(`La cover doit être exactement ${size}×${size} px`);
  }
}

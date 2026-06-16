import dotenv from 'dotenv';
dotenv.config();
import { createIvsLiveChannel, deleteIvsChannel, cleanupOrphanIvsChannels, isIvsConfigured } from '../services/ivsService.js';
import { v4 as uuidv4 } from 'uuid';

console.log('IVS configured:', isIvsConfigured());
const cleaned = await cleanupOrphanIvsChannels([]);
console.log('Orphan channels cleaned:', cleaned.deleted);

const id = uuidv4();
try {
  const ch = await createIvsLiveChannel(id, 'Test Artist');
  console.log('OK', {
    playbackUrl: ch.playbackUrl,
    rtmpsServer: ch.rtmpsServer,
    streamKeyPrefix: ch.streamKey?.slice(0, 8) + '…',
  });
  await deleteIvsChannel(ch.channelArn);
  console.log('Channel deleted');
} catch (e) {
  console.error('FAIL', e.name, e.message);
}

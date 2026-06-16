import dotenv from 'dotenv';
dotenv.config();
import { cleanupOrphanIvsChannels, deleteIvsChannel } from '../services/ivsService.js';
import { IvsClient, ListChannelsCommand } from '@aws-sdk/client-ivs';

const r = await cleanupOrphanIvsChannels([]);
console.log('cleanup result:', r);

const client = new IvsClient({
  region: process.env.AWS_IVS_REGION || 'eu-west-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const { channels } = await client.send(new ListChannelsCommand({ maxResults: 50 }));
console.log('remaining:', channels?.length || 0);
for (const ch of channels || []) {
  console.log(' deleting', ch.name);
  await deleteIvsChannel(ch.arn);
}

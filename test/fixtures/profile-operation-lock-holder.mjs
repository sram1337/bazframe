import { createServer } from 'node:net';
const server=createServer();
server.listen(process.env.LOCK_PATH,()=>process.send?.('ready'));
process.on('message',(message)=>{if(message==='close')server.close(()=>process.exit(0));});

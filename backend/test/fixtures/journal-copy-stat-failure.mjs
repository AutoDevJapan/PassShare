import fs from 'node:fs';
const open=fs.openSync.bind(fs),stat=fs.fstatSync.bind(fs);let owned;
fs.openSync=(file,flags,...rest)=>{const fd=open(file,flags,...rest);if(flags==='wx+')owned=fd;return fd;};
fs.fstatSync=(fd,...rest)=>{if(fd===owned)throw Error('Synthetic post-open private diagnostic');return stat(fd,...rest);};

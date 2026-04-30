import * as clob from '@polymarket/clob-client-v2';
console.log('Exports:', Object.keys(clob));
if (clob.SignatureType) console.log('SignatureType:', clob.SignatureType);
if (clob.SignatureTypeV1) console.log('SignatureTypeV1:', clob.SignatureTypeV1);

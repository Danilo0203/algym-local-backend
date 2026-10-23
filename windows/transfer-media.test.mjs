import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validatePackage, sha } from './transfer.mjs';

const ownerId = '11111111-1111-4111-8111-111111111111';
function packageWith(files) {
  return { kind: 'AlGym.Transfer', version: 1, createdAt: new Date().toISOString(), migrations: [], sequences: [],
    tables: [
      { schema: 'auth', name: 'users', columns: ['id','encrypted_password','deleted_at'], rows: [[ownerId,'$2b$12$synthetic',null]] },
      { schema: 'public', name: 'profiles', columns: ['id','role','is_active'], rows: [[ownerId,'owner','true']] },
      { schema: 'public', name: 'exercises', columns: ['id','image_url','animation_url'], rows: files.map((f,i) => [String(i+1),'/api/media/'+f.path,'/api/media/'+f.path]) },
    ], media: files };
}
function media(bytes, extension, kind = 'exercises') {
  return { path: `${kind}/${sha(bytes)}.${extension}`, sha256: sha(bytes), base64: bytes.toString('base64') };
}
const mp4 = await readFile(new URL('./fixtures/exercise.mp4', import.meta.url));
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');

test('el paquete de Windows admite GIF y MP4 de ejercicios sin alterar sus bytes', () => {
  const data = packageWith([media(mp4,'mp4'),media(gif,'gif')]);
  assert.equal(validatePackage(data),data);
  assert.deepEqual(Buffer.from(data.media[0].base64,'base64'),mp4);
  assert.deepEqual(Buffer.from(data.media[1].base64,'base64'),gif);
});
test('el importador mantiene hashes, límites, formato y confinamiento de MP4', () => {
  for(const kind of ['products','avatars','../exercises']) assert.throws(()=>validatePackage(packageWith([media(mp4,'mp4',kind)])));
  assert.throws(()=>validatePackage(packageWith([media(Buffer.from('fake'),'mp4')])));
  const tampered=media(mp4,'mp4');tampered.sha256='a'.repeat(64);
  assert.throws(()=>validatePackage(packageWith([tampered])));
  const large=Buffer.alloc(6*1024*1024);large.writeUInt32BE(large.length,0);large.write('free',4);
  assert.ok(validatePackage(packageWith([media(Buffer.concat([mp4,large]),'mp4')])));
  assert.throws(()=>validatePackage(packageWith([media(Buffer.concat([gif,large]),'gif')])));
  const oversized=Buffer.alloc(20*1024*1024);oversized.writeUInt32BE(oversized.length,0);oversized.write('free',4);
  assert.throws(()=>validatePackage(packageWith([media(Buffer.concat([mp4,oversized]),'mp4')])));
});

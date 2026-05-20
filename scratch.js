import { readObject } from './src/core/objects.js';
import { readCommit } from './src/core/commit.js';

const logitDir = "D:\\Def's work\\RSU Projects\\final project\\stock_tracker\\.logit";

const hashes = [
  'ff8f5bcaa371bc07b9ccd27405a92eaca48b3b22',
  'a3417869019fac7f08f95f1daea84f8b061cfb55',
  'b23a23452e104b62247e9d19999ba00c1cd3a36d',
  '0e72572e76ce3dab6e287d9c70258b5561235583',
  '27ede95937528be41221a0795671bbb11209243f',
  '72bbca2ec8523376a5c40a4a089411439e990bf0',
  '88555239e33107882ce4991fd71fa1ceb415127c',
  '32a1e61cdf1c2a028bb0f135703d074735c729fb'
];

for (const hash of hashes) {
  try {
    const obj = await readObject(logitDir, hash);
    console.log(`Hash: ${hash}`);
    console.log(`Type: ${obj.type}`);
    console.log(`Size: ${obj.size}`);
    if (obj.type === 'commit') {
      const commit = await readCommit(logitDir, hash);
      console.log(`Commit Message: ${commit.message}`);
      console.log(`Commit Author: ${commit.author}`);
      console.log(`Commit Parent: ${commit.parent}`);
      console.log(`Commit Tree: ${commit.tree}`);
    } else if (obj.type === 'blob') {
      console.log(`Content (first 100 chars): ${obj.content.toString('utf-8').substring(0, 100)}`);
    }
    console.log('------------------------------------');
  } catch (e) {
    console.log(`Failed to read ${hash}: ${e.message}`);
  }
}

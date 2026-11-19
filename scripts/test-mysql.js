import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if(!/^giveon_test(?:_[a-z0-9]+)?$/.test(process.env.MYSQL_TEST_DATABASE||'')) {
  console.error('격리 테스트 DB 이름 MYSQL_TEST_DATABASE=giveon_test를 지정해주세요. 테스트 중 이 DB의 데이터는 초기화됩니다.');
  process.exit(1);
}
const tests=readdirSync('test').filter(file=>file.endsWith('.test.js')).sort().map(file=>'test/'+file);
const result=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-reporter=spec',...tests,'test/mysql.integration.js'],{
  stdio:'inherit',env:{...process.env,GIVEON_TEST_DRIVER:'mysql'},windowsHide:true,timeout:300000,
});
process.exit(result.status??1);

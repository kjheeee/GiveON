import { Store } from './store.js';
import { MySQLStore } from './mysql-store.js';

export function createStore(settings) {
  if(settings.databaseDriver==='sqlite')return new Store(settings.databasePath);
  if(settings.databaseDriver==='mysql')return new MySQLStore(settings.mysql);
  throw new Error('DB_DRIVER는 sqlite 또는 mysql이어야 합니다.');
}

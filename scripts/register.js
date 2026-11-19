import { REST, Routes } from 'discord.js';
import { config } from '../src/config.js';
import { commands } from '../src/commands.js';
try {
  const settings = config();
  const route = settings.devGuildId ? Routes.applicationGuildCommands(settings.applicationId, settings.devGuildId) : Routes.applicationCommands(settings.applicationId);
  const body = commands.map(command => {
    const definition = command.toJSON();
    // contexts는 전역 명령용 필드입니다. 서버 명령은 그 서버에서만 표시됩니다.
    if (settings.devGuildId) delete definition.contexts;
    return definition;
  });
  await new REST({ version: '10' }).setToken(settings.token).put(route, { body });
  console.log(`${settings.devGuildId ? '개발 서버' : '전역'} 명령 ${commands.length}개 등록 완료`);
} catch (error) {
  console.error(`명령 등록 실패. .env와 봇 권한을 확인해주세요. 코드: ${typeof error.code === 'number' ? error.code : 'CONFIG_OR_NETWORK'}`);
  process.exitCode = 1;
}

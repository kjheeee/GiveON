import { SlashCommandBuilder, InteractionContextType } from 'discord.js';

export const commandAction=i=>{
  if(i.commandName!=='gon')return null;
  const group=i.options.getSubcommandGroup(false),action=i.options.getSubcommand();
  return group==='alert'?`alert:${action}`:action;
};

// 일반 이용은 안내 버튼, 관리자 작업·기록 조회·개인 알림 설정은 /gon 아래로 묶습니다.
export const commands = [
  new SlashCommandBuilder().setName('gon').setDescription('GiveON 이벤트 관리·조회·알림 설정').setContexts(InteractionContextType.Guild)
    .addSubcommand(command=>command.setName('init').setDescription('관리자 초기설정 팝업과 신청 안내 게시'))
    .addSubcommand(command=>command.setName('settings').setDescription('초기설정 완료 후 관리자 설정 화면 열기'))
    .addSubcommand(command=>command.setName('bump').setDescription('관리자 전용 진행 중 이벤트를 원래 채널의 최신 메시지로 재게시'))
    .addSubcommand(command=>command.setName('log').setDescription('이벤트·당첨 번호로 관련 기록 조회')
      .addStringOption(option=>option.setName('id').setDescription('이벤트·당첨 번호 또는 giveaway-delivery:번호').setRequired(true).setMaxLength(80)))
    .addSubcommand(command=>command.setName('reqblock').setDescription('관리자 전용 사용자 주최 제한·사유 기록')
      .addUserOption(option=>option.setName('user').setDescription('주최를 제한할 사용자').setRequired(true))
      .addStringOption(option=>option.setName('reason').setDescription('주최 제한 사유 (관리자에게만 표시)').setRequired(true).setMaxLength(500)))
    .addSubcommandGroup(group=>group.setName('alert').setDescription('내 이벤트 생성·승인·수령 진행 알림 DM 설정')
      .addSubcommand(command=>command.setName('on').setDescription('내 이벤트 진행 알림 DM 받기'))
      .addSubcommand(command=>command.setName('off').setDescription('내 이벤트 진행 알림 DM 끄기'))),
];

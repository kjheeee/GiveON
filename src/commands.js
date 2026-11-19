import { SlashCommandBuilder, InteractionContextType } from 'discord.js';

// 설치·설정은 관리자 명령, 일반 이용은 공개 안내 버튼으로 진행합니다.
export const commands = [
  new SlashCommandBuilder().setName('init').setDescription('관리자 전용 초기설정 후 선택한 채널에 신청 안내 게시').setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder().setName('setting').setDescription('초기설정 완료 후 GiveON 설정·관리 화면 열기').setContexts(InteractionContextType.Guild),
];

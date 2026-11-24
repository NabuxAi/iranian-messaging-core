// The five messengers, their official bot adapters (from the published
// messenger packages) and what the panel and Social need to show about them.
import { botAdapter as bale } from '@nabuxai/bale-mcp';
import { botAdapter as eitaa } from '@nabuxai/eitaa-mcp';
import { botAdapter as rubika } from '@nabuxai/rubika-mcp';
import { botAdapter as soroushplus } from '@nabuxai/soroushplus-mcp';
import { botAdapter as gap } from '@nabuxai/gap-mcp';

export const MESSENGERS = Object.freeze([
  {
    id: 'bale', adapter: bale, label: 'Bale', fa: 'بله', color: '#00A884',
    tokenHelp: {
      fa: 'در بله با @botfather یک بات بسازید و توکن آن را این‌جا بگذارید. برای انتشار در کانال، بات را مدیر کانال کنید.',
      en: 'Create a bot with @botfather in Bale and paste its token here. To post to a channel, make the bot an admin of it.'
    },
    chatHint: { fa: '‎@channel یا شناسهٔ عددی گفت‌وگو', en: '@channel or a numeric chat id' },
    tokenPlaceholder: '123456789:AbCdEf…'
  },
  {
    id: 'eitaa', adapter: eitaa, label: 'Eitaa', fa: 'ایتا', color: '#F7941D',
    tokenHelp: {
      fa: 'ایتا از راه ایتایار (eitaayar.ir) وصل می‌شود: توکن را از پنل ایتایار بگیرید و حساب ‎@sender را مدیر کانال کنید. ایتایار فقط ارسال دارد.',
      en: 'Eitaa connects through Eitaayar (eitaayar.ir): take the token from the Eitaayar panel and make @sender an admin of your channel. Eitaayar can only post.'
    },
    chatHint: { fa: 'نام کاربری یا شناسهٔ کانال در ایتا', en: 'the channel username or id in Eitaa' },
    tokenPlaceholder: 'bot12345:…'
  },
  {
    id: 'rubika', adapter: rubika, label: 'Rubika', fa: 'روبیکا', color: '#E2324A',
    tokenHelp: {
      fa: 'در روبیکا با ‎@BotFather یک بات بسازید و توکن آن را این‌جا بگذارید. بات باید مدیر کانال باشد.',
      en: 'Create a bot with @BotFather in Rubika and paste its token here. The bot must be an admin of the channel.'
    },
    chatHint: { fa: 'شناسهٔ گفت‌وگو (chat_id) در روبیکا', en: 'the chat_id in Rubika' },
    tokenPlaceholder: 'AAAA…'
  },
  {
    id: 'soroushplus', adapter: soroushplus, label: 'Soroush Plus', fa: 'سروش پلاس', color: '#1E88E5',
    tokenHelp: {
      fa: 'در سروش پلاس از سکوی بات (soroushplus.com) یک بات بسازید و توکن آن را این‌جا بگذارید.',
      en: 'Create a bot on the Soroush Plus bot platform (soroushplus.com) and paste its token here.'
    },
    chatHint: { fa: '‎@channel یا شناسهٔ عددی گفت‌وگو', en: '@channel or a numeric chat id' },
    tokenPlaceholder: '123456:…'
  },
  {
    id: 'gap', adapter: gap, label: 'Gap', fa: 'گپ', color: '#0098D8',
    tokenHelp: {
      fa: 'در developer.gap.im یک بات بسازید و توکن آن را این‌جا بگذارید. گپ راهی برای بررسی توکن ندارد؛ با اولین ارسال معلوم می‌شود.',
      en: 'Create a bot at developer.gap.im and paste its token here. Gap has no way to check a token; the first send tells.'
    },
    chatHint: { fa: 'شناسهٔ عددی گفت‌وگو در گپ', en: 'the numeric chat id in Gap' },
    tokenPlaceholder: 'a1b2c3…'
  }
]);

export function enabledMessengers(ids) {
  const wanted = new Set(ids);
  return MESSENGERS.filter(m => wanted.has(m.id));
}

export const messengerById = (list, id) => list.find(m => m.id === id) || null;
export const can = (messenger, capability) => messenger.adapter.capabilities.includes(capability);

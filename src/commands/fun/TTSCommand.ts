/**
 * TTSCommand.ts
 *
 * Comando `tts` (FUN) + servicio de síntesis en un solo archivo.
 * Convierte texto a nota de voz entendiendo Spanglish, SIN cambiar de voz a
 * mitad del mensaje (cada cambio dejaba silencios y se notaba mucho):
 *
 *  - Texto en español con algo de inglés/slang (lo normal): UNA llamada con
 *    Dalia (es-MX). Las palabras en inglés se reescriben fonéticamente en
 *    español ("shi" → "chi", "cool" → "cul") como las diría un latino.
 *  - Texto mayormente en inglés: UNA llamada con voz multilingüe.
 *
 * Uso: !tts <texto>
 *
 * Microsoft Edge neural TTS vía `msedge-tts` (sin API key). Servicio no
 * oficial; puede cambiar sin aviso. Notas aprendidas en producción:
 *  - WhatsApp solo reproduce notas de voz (ptt) en OGG/Opus; un mp3 ptt se
 *    descarta en silencio, por eso se transcodifica con ffmpeg.
 *  - El stream necesita timeout duro o una conexión colgada deja el comando
 *    sin responder.
 *
 * @author **Carlos G**
 */

import { spawn } from 'child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { Command } from '../Command.js';
import { logError } from '@/utils/logger.js';
import {
  CommandCategory,
  CommandContext,
  PermissionLevel,
  type MessageContext,
} from '@/types/index.js';

/* ========================================================================== */
/*  CONFIGURACIÓN                                                             */
/* ========================================================================== */

const ES_VOICE = 'es-MX-DaliaNeural';
/** Voz para texto mayormente en inglés. Verifica con MsEdgeTTS.getVoices(). */
const EN_VOICE = process.env.TTS_EN_VOICE ?? 'en-US-AvaMultilingualNeural';
const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const SYNTH_TIMEOUT_MS = 60000;
const MAX_TEXT_LENGTH = 500;
/** Con más de este % de palabras en inglés, todo el mensaje va con la voz inglesa. */
const ENGLISH_VOICE_RATIO = 0.5;
/**
 * Dalia no tiene el sonido /ʃ/ ("sh"). "ch" es el más cercano que sí puede
 * hacer. Si quieres probar otro: 'sh' (lo lee como "s"), 'sy', 'ch'.
 */
const SH_REPLACEMENT = 'ch';

/* ========================================================================== */
/*  LÉXICO — edita estas listas para "enseñarle" palabras                     */
/* ========================================================================== */

/**
 * Inglés/slang → cómo lo escribiría un latino para que Dalia lo diga bien.
 * Las claves también cuentan como "palabra en inglés" al detectar idioma.
 */
const PHONETIC: Record<string, string> = {
  // slang / redes
  shi: 'chi',
  shit: 'chit',
  shut: 'chat',
  bro: 'bro',
  bruh: 'bro',
  cringe: 'crinch',
  vibe: 'vaib',
  vibes: 'vaibs',
  crush: 'crash',
  chill: 'chil',
  ghost: 'gost',
  ghosting: 'gosting',
  hype: 'jaip',
  mood: 'mud',
  fake: 'feik',
  dude: 'diud',
  girl: 'guerl',
  baby: 'beibi',
  wow: 'guau',
  omg: 'o em yi',
  lol: 'lol',
  nice: 'nais',
  cool: 'cul',
  crazy: 'creisi',
  savage: 'sávach',
  slay: 'slei',
  queen: 'cuin',
  goat: 'got',
  noob: 'nub',
  clutch: 'clach',
  rage: 'reich',
  cap: 'cap',
  // gaming / streaming
  game: 'gueim',
  gamer: 'gueimer',
  gaming: 'gueimin',
  stream: 'strim',
  streamer: 'strimer',
  live: 'laiv',
  follow: 'fólou',
  like: 'laik',
  share: 'cher',
  subscribe: 'sabscraib',
  loot: 'lut',
  squad: 'scuad',
  team: 'tim',
  headshot: 'jedchot',
  ranked: 'ranct',
  win: 'uin',
  lose: 'lus',
  gg: 'yi yi',
  // apps / marcas
  whatsapp: 'guatsap',
  wifi: 'guaifai',
  iphone: 'aifon',
  youtube: 'yutub',
  // comunes
  ok: 'okei',
  okay: 'okei',
  yeah: 'ye',
  hello: 'jelou',
  hey: 'jei',
  hi: 'jai',
  bye: 'bai',
  please: 'plis',
  sorry: 'sori',
  thanks: 'tenks',
  thank: 'tenk',
  you: 'yu',
  love: 'lov',
  hate: 'jeit',
  friend: 'frend',
  friends: 'frends',
  party: 'parti',
  good: 'gud',
  shopping: 'chopin',
  shop: 'chop',
  show: 'chou',
  shirt: 'cherd',
};

/** Palabras en inglés sin respelling especial (cuentan para detectar idioma). */
const ENGLISH_WORDS = new Set([
  'the',
  'and',
  'but',
  'with',
  'for',
  'this',
  'that',
  'what',
  'why',
  'how',
  'who',
  'when',
  'where',
  'your',
  'yours',
  'my',
  'we',
  'they',
  'she',
  'are',
  'was',
  'were',
  'be',
  'have',
  'has',
  'does',
  'did',
  'can',
  'could',
  'would',
  'should',
  'will',
  'just',
  'not',
  'yes',
  'best',
  'worst',
  'time',
  'today',
  'tomorrow',
  'night',
  'morning',
  'work',
  'home',
  'life',
  'people',
  'right',
  'wrong',
  'think',
  'know',
  'want',
  'need',
  'feel',
  'look',
  'make',
  'take',
  'give',
  'going',
  'back',
  'out',
  'over',
  'now',
  'never',
  'always',
  'really',
  'very',
  'much',
  'more',
  'less',
  'all',
  'only',
  'still',
  'again',
  'bad',
  'random',
  'flex',
  'fire',
  'lit',
  'boss',
  'skin',
  'chat',
  'link',
  'lag',
  'ping',
  'rank',
  'level',
  'team',
  'nah',
  'yo',
  'gonna',
  'wanna',
  'gotta',
  "don't",
  "i'm",
  "it's",
  "let's",
  "can't",
  "won't",
  "that's",
  "what's",
  "you're",
  "they're",
  "we're",
  "i'll",
  "i've",
]);

/**
 * Existen en español E inglés. No cuentan como inglés al decidir la voz
 * (se quedan como vengan, con la voz que toque).
 */
const AMBIGUOUS_WORDS = new Set([
  'me',
  'he',
  'no',
  'a',
  'in',
  'is',
  'come',
  'pan',
  'red',
  'sin',
  'on',
  'so',
  'to',
  'i',
  'it',
  'an',
  'as',
  'at',
  'do',
  'go',
  'or',
  'pie',
  'fin',
  'mar',
  'son',
  'one',
  'real',
  'sus',
  'once',
  'pro',
]);

/** Siempre español (ganan sobre las demás reglas). */
const SPANISH_WORDS = new Set(['tu', 'mi', 'si', 'se', 'el', 'la', 'de', 'que', 'y']);

/** Reescritura para la voz INGLESA (solo el slang que ella lee raro). */
const EN_VOICE_RESPELL: Record<string, string> = { shi: 'shee' };

/** Abreviaciones de chat → texto hablado. */
const CHAT_ABBR: Record<string, string> = {
  xq: 'porque',
  pq: 'porque',
  q: 'que',
  tmb: 'también',
  tb: 'también',
  xfa: 'por favor',
  pls: 'please',
  plz: 'please',
  ntp: 'no te preocupes',
  bn: 'bien',
  dnd: 'donde',
  msj: 'mensaje',
  k: 'que',
  d: 'de',
  x: 'por',
};

/** Patrones casi inexistentes en español: detectan inglés fuera del léxico. */
const ENGLISH_PATTERN = /(?:sh|th|ck|ough|ght|wh)|(?:ing|'s|n't|'m|'re|'ll|'ve|'d)$/;
/**
 * Terminaciones españolas: "beshito", "bechiiito" son español con "sh" de
 * cariño, NO inglés; se quedan con Dalia.
 */
const SPANISH_SUFFIX = /(?:it[oa]s?|ot[ea]s?|ón|ones|os[oa]s?|ando|iendo|mente)$/;

/* ========================================================================== */
/*  NORMALIZACIÓN Y DETECCIÓN DE IDIOMA                                       */
/* ========================================================================== */

const WORD_RE = /[\p{L}']+/gu;

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Limpia el texto para que la voz no lea basura. */
export function normalizeText(raw: string): string {
  return raw
    .replace(/[\u2018\u2019]/g, "'") // apóstrofes curvos
    .replace(/https?:\/\/\S+/gi, '') // URLs
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '') // emojis
    .replace(/\b(?:ja|je|ji|jo|ju){3,}\b/gi, 'jajaja') // jajajajaja
    .replace(/(\p{L})\1{2,}/gu, '$1$1') // holaaaaa → holaa
    .replace(WORD_RE, w => CHAT_ABBR[w.toLowerCase()] ?? w) // xq → porque
    .replace(/\s+/g, ' ')
    .trim();
}

/** Candidatos de búsqueda: "shii" → ["shii", "shi"]. */
const candidates = (key: string): string[] => [key, key.replace(/(.)\1+/g, '$1')];

type Kind = 'es' | 'en' | 'ambiguous';

function classify(word: string): Kind {
  const key = word.toLowerCase().replace(/^'+|'+$/g, '');
  if (SPANISH_WORDS.has(key) || /[áéíóúñü]/.test(key)) return 'es';
  if (AMBIGUOUS_WORDS.has(key)) return 'ambiguous';
  for (const c of candidates(key)) {
    if (PHONETIC[c] !== undefined || ENGLISH_WORDS.has(c)) return 'en';
  }
  if (key.length >= 3 && !SPANISH_SUFFIX.test(key) && ENGLISH_PATTERN.test(key)) return 'en';
  return 'es';
}

/** Fracción de palabras (sin contar ambiguas) que están en inglés. */
export function englishRatio(text: string): number {
  let en = 0;
  let total = 0;
  for (const word of text.match(WORD_RE) ?? []) {
    const kind = classify(word);
    if (kind === 'ambiguous') continue;
    total++;
    if (kind === 'en') en++;
  }
  return total === 0 ? 0 : en / total;
}

/** Reescribe el inglés como lo diría un latino, para la voz en español. */
export function toLatinSpanglish(text: string): string {
  return text.replace(WORD_RE, word => {
    const key = word.toLowerCase();
    for (const c of candidates(key)) {
      const phonetic = PHONETIC[c];
      if (phonetic === undefined) continue;
      // Conserva el alargado: "shii" → "chii".
      const tail = key.match(/([aeiouy])\1+$/);
      return tail && c !== key ? phonetic + tail[1] : phonetic;
    }
    // Fuera del léxico: solo arregla el sonido "sh" (beshiiito → bechiito).
    return /sh/i.test(word) ? word.replace(/sh/gi, SH_REPLACEMENT) : word;
  });
}

/** Ajustes mínimos para la voz inglesa. */
function toEnglishVoiceText(text: string): string {
  return text.replace(WORD_RE, word => {
    for (const c of candidates(word.toLowerCase())) {
      const respell = EN_VOICE_RESPELL[c];
      if (respell !== undefined) return respell;
    }
    return word;
  });
}

/* ========================================================================== */
/*  SERVICIO                                                                  */
/* ========================================================================== */

/** Transcodifica un Buffer mp3 a OGG/Opus (nota de voz de WhatsApp). */
export function mp3ToOggOpus(mp3: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      // La entrada por pipe no tiene header seekable: declara el formato o ffmpeg se cuelga.
      '-f',
      'mp3',
      '-i',
      'pipe:0',
      '-c:a',
      'libopus',
      '-b:a',
      '48k',
      '-application',
      'voip',
      '-f',
      'ogg',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    const errors: string[] = [];
    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk: Buffer) => errors.push(chunk.toString()));
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code: number) => {
      if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg opus failed (${code}): ${errors.join('')}`));
    });
    ffmpeg.stdin.on('error', () => {
      /* ffmpeg murió antes de leer todo; el error real llega por 'close' */
    });
    ffmpeg.stdin.end(mp3);
  });
}

export class TTSService {
  /** Neural TTS con Spanglish; devuelve un Buffer OGG/Opus listo como nota de voz. */
  async synthesize(rawText: string): Promise<Buffer> {
    const text = normalizeText(rawText);
    if (!text) throw new Error('Texto vacío tras normalizar');

    const spanish = toLatinSpanglish(text);
    let mp3: Buffer;

    if (englishRatio(text) > ENGLISH_VOICE_RATIO) {
      try {
        mp3 = await this.streamMp3(EN_VOICE, toEnglishVoiceText(text));
      } catch (error) {
        // La voz inglesa no existe o falló: Dalia con el texto "latinizado".
        logError('[TTSService] voz inglesa falló, usando Dalia', error);
        mp3 = await this.streamMp3(ES_VOICE, spanish);
      }
    } else {
      mp3 = await this.streamMp3(ES_VOICE, spanish);
    }

    return await mp3ToOggOpus(mp3);
  }

  private async streamMp3(voice: string, text: string): Promise<Buffer> {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, FORMAT);
    const { audioStream } = tts.toStream(escapeXml(text));

    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        audioStream.destroy();
        reject(new Error(`TTS timeout tras ${SYNTH_TIMEOUT_MS}ms (${voice})`));
      }, SYNTH_TIMEOUT_MS);

      audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      audioStream.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      audioStream.on('end', () => {
        clearTimeout(timer);
        const audio = Buffer.concat(chunks);
        if (audio.length === 0) reject(new Error(`Empty TTS audio (${voice})`));
        else resolve(audio);
      });
    });
  }
}

export const ttsService = new TTSService();

/* ========================================================================== */
/*  COMANDO                                                                   */
/* ========================================================================== */

/** Command handler for `!tts`: Converts text to speech. */
export class TTSCommand extends Command {
  name = 'tts';
  /** Síntesis neural + transcodificación ffmpeg en enlace lento. */
  timeout = 120000;
  description = 'Convierte texto a voz (entiende español e inglés)';
  category = CommandCategory.FUN;
  aliases = ['speak', 'say', 'hablar', 'ttsvoz'];
  cooldown = 15000;
  contexts = [CommandContext.BOTH];
  usage = '!tts <texto>';
  examples = ['!tts Hola mundo', '!tts Orbit es genial', '!tts Bro eso estuvo shi, no manches'];
  permissions = { user: [PermissionLevel.USER], bot: [] };

  async execute(ctx: MessageContext): Promise<void> {
    const text = ctx.args?.join(' ').trim();

    if (!text) {
      await ctx.reply('✍️ *Uso:* !tts <texto>\n_Ejemplo: !tts Hola Orbit_');
      return;
    }

    if (text.length > MAX_TEXT_LENGTH) {
      await ctx.reply(`❌ El texto es muy largo (máx ${MAX_TEXT_LENGTH} caracteres)`);
      return;
    }

    if (!normalizeText(text)) {
      await ctx.reply('❌ No hay nada que leer en ese texto (solo links o emojis).');
      return;
    }

    await ctx.react('🔊');

    try {
      const audioBuffer = await ttsService.synthesize(text);

      await ctx.sock.sendMessage(ctx.chat.jid, {
        audio: audioBuffer,
        // Voice notes must be OGG/Opus; an mp3 ptt is dropped silently.
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
      });

      await ctx.react('✅');
    } catch (error) {
      logError('[TTSCommand]', error);
      await ctx.react('❌');
      await ctx.reply('❌ No pude convertir el texto a voz. Intenta de nuevo.');
    }
  }
}

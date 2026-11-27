/**
 * commandLanes.test.ts
 *
 * Pins the concurrency contract:
 * - commands that move money stay sequential (addMoney is read-modify-write),
 * - downloads opt into the heavy lane,
 * - stickers use the heavy lane too.
 */

import { describe, it, expect } from 'vitest';
import { BlackjackCommand } from '@/commands/game/BlackjackCommand.js';
import { CoinflipCommand } from '@/commands/game/CoinflipCommand.js';
import { DiceCommand } from '@/commands/game/DiceCommand.js';
import { RouletteCommand } from '@/commands/game/RouletteCommand.js';
import { YtMp3Command } from '@/commands/media/download/YtMp3Command.js';
import { YtMp4Command } from '@/commands/media/download/YtMp4Command.js';
import { TiktokCommand } from '@/commands/media/download/TiktokCommand.js';
import { InstagramCommand } from '@/commands/media/download/InstagramCommand.js';
import { FacebookCommand } from '@/commands/media/download/FacebookCommand.js';
import { TwitterCommand } from '@/commands/media/download/TwitterCommand.js';
import { StickerCommand } from '@/commands/media/StickerCommand.js';

const MONEY_COMMANDS = [BlackjackCommand, CoinflipCommand, DiceCommand, RouletteCommand];
const DOWNLOADS = [
  YtMp3Command,
  YtMp4Command,
  TiktokCommand,
  InstagramCommand,
  FacebookCommand,
  TwitterCommand,
];

describe('command concurrency lanes', () => {
  it('keeps money-mutating games on the sequential lane', () => {
    for (const CommandClass of MONEY_COMMANDS) {
      const command = new CommandClass();
      expect(command.parallelizable, command.name).toBe(false);
      expect(command.heavy, command.name).toBe(false);
    }
  });

  it('marks downloads as heavy so they cannot fill the parallel lane', () => {
    for (const CommandClass of DOWNLOADS) {
      const command = new CommandClass();
      expect(command.heavy, command.name).toBe(true);
    }
  });

  it('marks stickers as heavy parallel work', () => {
    const sticker = new StickerCommand();
    expect(sticker.parallelizable).toBe(true);
    expect(sticker.heavy).toBe(true);
  });
});

/**
 * commandLanes.test.ts
 *
 * Pins the concurrency contract:
 * - commands that move money stay sequential (addMoney is read-modify-write),
 *   even though their classes no longer hard-code the flag,
 * - ordinary commands run in the parallel lane by default, so one slow
 *   command no longer holds up the next one,
 * - explicit flags override the category rule,
 * - downloads opt into the heavy lane,
 * - stickers use the heavy lane too.
 */

import { describe, it, expect } from 'vitest';
import { laneForCommand } from '@/core/CommandLane.js';
import { CommandCategory } from '@/types/index.js';
import { BlackjackCommand } from '@/commands/game/BlackjackCommand.js';
import { CoinflipCommand } from '@/commands/game/CoinflipCommand.js';
import { DiceCommand } from '@/commands/game/DiceCommand.js';
import { RouletteCommand } from '@/commands/game/RouletteCommand.js';
import { BalanceCommand } from '@/commands/economy/BalanceCommand.js';
import { PingCommand } from '@/commands/utility/system/PingCommand.js';
import { QuizCommand } from '@/commands/utility/quiz/QuizCommand.js';
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
      expect(laneForCommand(command), command.name).toBe('sequential');
      expect(command.heavy, command.name).toBe(false);
    }
  });

  it('runs ordinary commands in parallel instead of queueing them one by one', () => {
    expect(laneForCommand(new PingCommand())).toBe('parallel');
    expect(laneForCommand(new BalanceCommand())).toBe('parallel');
  });

  it('honours an explicit opt-out even outside a serial category', () => {
    expect(laneForCommand(new QuizCommand())).toBe('sequential');
    expect(laneForCommand({ category: CommandCategory.UTILITY, parallelizable: false })).toBe(
      'sequential',
    );
  });

  it('lets an explicit opt-in beat a serial category', () => {
    expect(laneForCommand({ category: CommandCategory.ECONOMY, parallelizable: true })).toBe(
      'parallel',
    );
  });

  it('gives heavy commands precedence over everything else', () => {
    expect(
      laneForCommand({ category: CommandCategory.MEDIA, parallelizable: true, heavy: true }),
    ).toBe('heavy');
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

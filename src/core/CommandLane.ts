/**
 * CommandLane.ts
 *
 * Chooses the concurrency lane of a command from its flags and category.
 *
 * @author **Carlos G**
 */

import { CommandCategory } from '@/types/index.js';
import type { MessageLane } from './RealTimeMessageProcessor.js';

/**
 * Categories whose commands do read-modify-write on shared state (money,
 * XP, warnings, group settings). Running two at once loses updates, so they
 * stay on the sequential lane.
 */
const SERIAL_CATEGORIES = new Set<CommandCategory>([
  CommandCategory.ECONOMY,
  CommandCategory.GAME,
  CommandCategory.RPG,
  CommandCategory.MODERATION,
  CommandCategory.GROUP,
  CommandCategory.ADMIN,
  CommandCategory.OWNER,
  CommandCategory.SUBBOT,
]);

/**
 * Concurrency lane for a command.
 *
 * Explicit flags win; otherwise only the state-mutating categories stay
 * serial, and every other command runs concurrently. Defaulting to serial
 * made a single slow command hold up every later one, which is the opposite
 * of what the capped lanes exist for.
 *
 * An unknown command (a lazy plugin not registered yet) stays sequential: it
 * only costs its first run, and the next one takes the lane its flags ask for.
 */
export function laneForCommand(command?: {
  category?: CommandCategory;
  parallelizable?: boolean;
  heavy?: boolean;
}): MessageLane {
  if (!command) return 'sequential';
  if (command.heavy) return 'heavy';
  if (command.parallelizable !== undefined) {
    return command.parallelizable ? 'parallel' : 'sequential';
  }
  if (command.category && SERIAL_CATEGORIES.has(command.category)) return 'sequential';
  return 'parallel';
}

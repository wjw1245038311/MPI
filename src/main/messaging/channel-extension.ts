import { writeFileSync } from "node:fs";
import { join } from "node:path";
import channelSource from "./channel-command-ext.ts?raw";

/**
 * The channel session bridge extension (channel-command-ext.ts) is bundled into
 * the main process as a raw string and written into userData at runtime, then
 * loaded for every thread via `pi --extension <path>` — same pattern as the
 * todo bridge. It gives the agent mpi_channel_* tools that manage the chat
 * channel's active session through the inbox directory (see channel-command.ts).
 */

let cachedPath: string | null = null;

/** Write the channel extension into userData (once) and return its absolute path. */
export function ensureChannelExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "mpi-channel.ts");
  writeFileSync(file, channelSource, "utf8");
  cachedPath = file;
  return file;
}

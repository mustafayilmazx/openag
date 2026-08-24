import { describe, expect, test } from "bun:test";
import {
  getBrainDirs,
  getConvDirs,
  IDE_BRAIN_DIR,
  IDE_CONV_DIR,
  NON_IDE_BRAIN_DIR,
  NON_IDE_CONV_DIR,
  resolveConversationDb,
  resolveTranscriptPath,
} from "../src/core/sqlite-utils.js";

describe("Multi-Root Directory & SQLite Resolution", () => {
  test("provides paths for both non-IDE and IDE directories", () => {
    expect(NON_IDE_BRAIN_DIR).toBeTruthy();
    expect(NON_IDE_CONV_DIR).toBeTruthy();
    expect(IDE_BRAIN_DIR).toBeTruthy();
    expect(IDE_CONV_DIR).toBeTruthy();

    expect(NON_IDE_BRAIN_DIR).toContain("antigravity");
    expect(IDE_BRAIN_DIR).toContain("antigravity-ide");
  });

  test("getBrainDirs and getConvDirs return non-empty directory lists", () => {
    const brainDirs = getBrainDirs();
    const convDirs = getConvDirs();

    expect(Array.isArray(brainDirs)).toBe(true);
    expect(brainDirs.length).toBeGreaterThan(0);
    expect(Array.isArray(convDirs)).toBe(true);
    expect(convDirs.length).toBeGreaterThan(0);
  });

  test("resolveConversationDb resolves existing conversation or returns null for non-existent", () => {
    const nonExistent = resolveConversationDb("non-existent-conversation-id-12345");
    expect(nonExistent).toBeNull();
  });

  test("resolveTranscriptPath resolves existing transcript or returns null for non-existent", () => {
    const nonExistent = resolveTranscriptPath("non-existent-conversation-id-12345");
    expect(nonExistent).toBeNull();
  });
});

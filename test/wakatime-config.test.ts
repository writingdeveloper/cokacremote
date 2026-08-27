import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("ChatGPT WakaTime config", () => {
  it("is opt-in and uses ChatGPT plus a GPT model identity", () => {
    const disabled = loadConfig({ MCP_AUTH_TOKEN: "secret" }, "/tmp");
    expect(disabled).toMatchObject({
      wakatimeEnabled: false,
      wakatimeCli: undefined,
      wakatimeHome: undefined,
      wakatimeConfig: undefined,
      wakatimeModel: "gpt/5.6-sol",
      wakatimePlugin: "chatgpt-web/0.1.0",
      wakatimeTrackReads: true,
      wakatimeTrackShellChanges: true,
    });

    const enabled = loadConfig(
      {
        MCP_AUTH_TOKEN: "secret",
        MCP_WAKATIME_ENABLED: "true",
        MCP_WAKATIME_CLI: "/opt/wakatime-cli",
        MCP_WAKATIME_HOME: "/tmp/cokacremote-wakatime",
        MCP_WAKATIME_CONFIG: "/home/test/.wakatime.cfg",
        MCP_WAKATIME_MODEL: "gpt/5.6-sol",
        MCP_WAKATIME_PLUGIN: "chatgpt-web/0.2.0",
        MCP_WAKATIME_TRACK_READS: "false",
        MCP_WAKATIME_TRACK_SHELL_CHANGES: "false",
      },
      "/tmp",
    );
    expect(enabled).toMatchObject({
      wakatimeEnabled: true,
      wakatimeCli: "/opt/wakatime-cli",
      wakatimeHome: "/tmp/cokacremote-wakatime",
      wakatimeConfig: "/home/test/.wakatime.cfg",
      wakatimeModel: "gpt/5.6-sol",
      wakatimePlugin: "chatgpt-web/0.2.0",
      wakatimeTrackReads: false,
      wakatimeTrackShellChanges: false,
    });
  });
});